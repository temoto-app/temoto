/**
 * The migration mechanism. It uses `user_version` as the version number and applies forward only.
 * Each version is applied in one transaction, and if it fails midway the version number is not raised.
 */
import type { Database } from 'better-sqlite3-multiple-ciphers'
import { log } from './logger.js'
import { foldPath } from './uri.js'
import { clipPermissionInput } from './clip-json.js'
import type { JsonValue } from '../shared/agent.js'
import { webHostOf } from '@shared/web-view.js'

export interface Migration {
  readonly version: number
  readonly name: string
  readonly up: string
  /**
   * Makes a migration that only adds a column idempotent (TODO 1106). If this table already has this column, the number is advanced without running `up`
   * (`ALTER TABLE … ADD COLUMN` has no IF NOT EXISTS. There is a test that rewinds the number and applies again).
   */
  readonly skipIfColumn?: { readonly table: string; readonly column: string }
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]
  return rows.some((row) => row.name === column)
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'files',
    up: `
      -- FsService の走査結果。ARCHITECTURE.md 4.4 の参照範囲と除外リストに従う。
      -- path_folded が主キー: APFS は既定で大文字小文字を区別しないため、
      -- 畳み込んだ値を同一性の基準にする (PHASE1_BRIEF 3.3)。
      CREATE TABLE files (
        path_folded   TEXT PRIMARY KEY,
        path          TEXT NOT NULL,
        parent_folded TEXT,
        name          TEXT NOT NULL,
        name_folded   TEXT NOT NULL,
        ext           TEXT NOT NULL DEFAULT '',
        is_dir        INTEGER NOT NULL,
        size          INTEGER NOT NULL DEFAULT 0,
        mtime_ms      INTEGER NOT NULL DEFAULT 0,
        dev           INTEGER NOT NULL DEFAULT 0,
        ino           INTEGER NOT NULL DEFAULT 0,
        seen_at       INTEGER NOT NULL
      );
      CREATE INDEX files_parent ON files (parent_folded, is_dir DESC, name_folded);
      CREATE INDEX files_name ON files (name_folded);

      -- 走査でアクセスできなかったディレクトリ。TCC 拒否をエラーにせず記録し、
      -- まとめて Full Disk Access を案内するために使う (PHASE1_BRIEF 3.3)。
      CREATE TABLE scan_denials (
        path_folded TEXT PRIMARY KEY,
        path        TEXT NOT NULL,
        code        TEXT NOT NULL,
        seen_at     INTEGER NOT NULL
      );

      -- 走査 1 回分の記録。UI の進捗と、再走査の判断に使う。
      CREATE TABLE scan_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        root        TEXT NOT NULL,
        started_at  INTEGER NOT NULL,
        finished_at INTEGER,
        seen        INTEGER NOT NULL DEFAULT 0,
        indexed     INTEGER NOT NULL DEFAULT 0,
        excluded    INTEGER NOT NULL DEFAULT 0,
        denied      INTEGER NOT NULL DEFAULT 0,
        state       TEXT NOT NULL
      );
    `
  },
  {
    version: 2,
    name: 'threads',
    up: `
      -- スレッド (ARCHITECTURE.md 4.3.1)。常に永続。
      -- backend 列は 4.6.1 の「スレッドはバックエンドを属性として持つ」に対応する。
      -- 列名にバックエンド固有の語を使わない (制約 6)。4.3.1 の表が挙げている
      -- 「<バックエンド名>_session_id」は backend_session_id、cli_version は
      -- backend_version とした。
      CREATE TABLE threads (
        id                 TEXT PRIMARY KEY,
        title              TEXT NOT NULL,
        cwd                TEXT NOT NULL,
        -- 無承認で読める範囲 (4.4)。JSON 配列の絶対パス。
        allowed_dirs       TEXT NOT NULL DEFAULT '[]',
        backend            TEXT NOT NULL DEFAULT 'agent-cli',
        -- 'none' | 'days' | 'forever' (4.3.1)
        retention          TEXT NOT NULL DEFAULT 'forever',
        retention_days     INTEGER,
        unread             INTEGER NOT NULL DEFAULT 0,
        archived           INTEGER NOT NULL DEFAULT 0,
        -- 非安全オプション (4.2)。1 にするとユーザ設定を読み込み、承認されない操作が出る。
        load_user_settings INTEGER NOT NULL DEFAULT 0,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL,
        last_event_at      INTEGER
      );
      CREATE INDEX threads_updated ON threads (archived, updated_at DESC);

      -- セッション。**通常の再開では行が増えない** (spike 1: --resume で
      -- session_id が変わらない)。増えるのは分岐したときだけ (4.3.1)。
      CREATE TABLE sessions (
        id                 TEXT PRIMARY KEY,
        thread_id          TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        backend_session_id TEXT NOT NULL,
        forked_from        TEXT,
        started_at         INTEGER NOT NULL,
        ended_at           INTEGER,
        backend_version    TEXT,
        -- 累積ターン数は aios 側で数える (result.num_turns は累積ではない — spike 1)。
        turns              INTEGER NOT NULL DEFAULT 0,
        cost_usd           REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX sessions_thread ON sessions (thread_id, started_at);
      CREATE UNIQUE INDEX sessions_backend ON sessions (backend_session_id);

      -- タイムラインの正本 (6.5 の canonical store)。
      -- 保存しないもの (4.3.1 / 制約 10): tool_result の中身、thinking、delta、
      -- 添付画像の実体、巨大な引数。payload は redaction 済みの JSON。
      CREATE TABLE thread_events (
        id                 TEXT PRIMARY KEY,
        thread_id          TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        session_id         TEXT,
        seq                INTEGER NOT NULL,
        ts                 INTEGER NOT NULL,
        kind               TEXT NOT NULL,
        actor              TEXT NOT NULL DEFAULT 'main',
        parent_tool_use_id TEXT,
        payload            TEXT NOT NULL,
        payload_bytes      INTEGER NOT NULL
      );
      CREATE INDEX thread_events_thread ON thread_events (thread_id, seq);

      -- アプリ設定 (並走数、アイドル停止、既定 retention)。1 行 1 キー。
      CREATE TABLE app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `
  },
  {
    version: 3,
    name: 'documents',
    up: `
      -- 共通 Document スキーマ (ARCHITECTURE.md 6.3) と索引 (6.4)。
      --
      -- **Phase 1 の files テーブルをここへ統合する** (12.4 の宿題)。
      -- files は path と path_folded と parent_folded を持ち、索引 2 本を載せていたため
      -- 1 行 640 バイト (25 万件で 160 MB) になっていた。documents は
      -- **パスを 1 回も持たない**: 行が持つのは name と親の id だけで、絶対パスは
      -- 親子をたどって復元する。fs 以外のソース (会話・転写) は uri を持つ。
      --
      -- 制約 9: 本文 (body) の列は無い。6.3 の body はパイプライン内の受け渡し用。
      CREATE TABLE documents (
        id           INTEGER PRIMARY KEY,
        -- 'fs' | 'conversation' | 'transcript' | 将来のプラグイン名
        source       TEXT NOT NULL,
        -- fs: 親ディレクトリの documents.id。ツリー表示とパス復元に使う。
        parent_id    INTEGER REFERENCES documents(id) ON DELETE CASCADE,
        -- fs: ファイル名 / 他: タイトル
        name         TEXT NOT NULL,
        name_folded  TEXT NOT NULL,
        -- 'directory' | 'file' | 'message'
        kind         TEXT NOT NULL,
        -- fs 以外のソース内一意 ID (会話は thread_events.id、転写は file#offset)
        source_id    TEXT,
        -- fs は NULL (パスは親子から復元する)。会話は thread://、転写は transcript://
        uri          TEXT,
        ext          TEXT NOT NULL DEFAULT '',
        size         INTEGER NOT NULL DEFAULT 0,
        mtime_ms     INTEGER NOT NULL DEFAULT 0,
        updated_at   INTEGER NOT NULL DEFAULT 0,
        -- 変更検知用 (fs は mtime+size、会話は uuid)。6.2 の Deduplicate 段が見る。
        version      TEXT NOT NULL DEFAULT '',
        -- 抽出本文の SHA-256。未抽出は NULL。
        content_hash TEXT,
        -- 6.2 Metadata 段の言語判定。'ja' なら分かち書き、それ以外は原文のまま。
        lang         TEXT,
        sensitivity  TEXT NOT NULL DEFAULT 'normal',
        -- 6.3: 「検索できる」と「AI に渡してよい」を分ける。gateway は ui+ai だけ返す。
        exposure     TEXT NOT NULL DEFAULT 'ui+ai',
        metadata     TEXT,
        -- 'pending' | 'indexed' | 'skipped' | 'failed'。**中断と再開の位置はこれで持つ**。
        index_state  TEXT NOT NULL DEFAULT 'pending',
        indexed_at   INTEGER,
        seen_at      INTEGER NOT NULL DEFAULT 0
      );
      -- fs のツリー。同じ親に同じ名前は 1 つ (APFS は既定で大文字小文字を区別しない)。
      CREATE UNIQUE INDEX documents_tree ON documents (parent_id, name_folded)
        WHERE source = 'fs';
      CREATE UNIQUE INDEX documents_source ON documents (source, source_id)
        WHERE source_id IS NOT NULL;
      -- ファイル名検索 (Phase 1 から継続。本文検索とは別の窓)。
      CREATE INDEX documents_name ON documents (name_folded);
      -- 索引構築の残件取得。部分索引なので 100 万行あっても走査は残件だけで済む。
      CREATE INDEX documents_pending ON documents (index_state, id)
        WHERE index_state = 'pending';

      -- 検索単位 (6.2 の Chunk 段)。**本文は持たない** — 正本中の位置だけを持ち、
      -- 表示用スニペットは正本から切り出す (6.5、spike 11 のスニペット品質問題)。
      CREATE TABLE chunks (
        id          INTEGER PRIMARY KEY,
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        seq         INTEGER NOT NULL,
        -- 正本 (ファイル / thread_events.payload / 転写行) の中のバイト範囲。
        byte_start  INTEGER NOT NULL,
        byte_end    INTEGER NOT NULL,
        chars       INTEGER NOT NULL
      );
      CREATE INDEX chunks_document ON chunks (document_id, seq);

      -- FTS5 (6.4.1)。**contentless (content='')** にして本文の複製を作らない。
      -- 入るのは分かち書き済みの影武者テキストだけで、これは読める形ではないので
      -- snippet() は使わない (6.5)。contentless_delete=1 は SQLite 3.43+ の機能で、
      -- 実機は 3.53.4。これにより削除 (tombstone) が普通の DELETE で書ける。
      -- rowid は chunks.id と一致させる。
      CREATE VIRTUAL TABLE chunk_fts USING fts5(
        text,
        tokenize = 'unicode61 remove_diacritics 2',
        content = '',
        contentless_delete = 1
      );

      -- 索引構築 1 回分の記録 (UI の進捗と再開の判断)。
      CREATE TABLE index_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at  INTEGER NOT NULL,
        finished_at INTEGER,
        indexed     INTEGER NOT NULL DEFAULT 0,
        skipped     INTEGER NOT NULL DEFAULT 0,
        failed      INTEGER NOT NULL DEFAULT 0,
        state       TEXT NOT NULL
      );

      -- 失敗した文書のデッドレター (6.2)。ソースごとの再試行と統計に使う。
      CREATE TABLE index_failures (
        document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        reason      TEXT NOT NULL,
        at          INTEGER NOT NULL
      );

      -- Phase 1 の files は documents に統合したので落とす。
      -- 中身は走査で作り直せる (正本はディスク上のファイル — 6.5)。
      DROP TABLE files;
    `
  },
  {
    version: 4,
    name: 'index-progress',
    up: `
      -- 進捗集計 (GROUP BY index_state) がテーブル全走査にならないようにする。
      -- 25 万行を毎秒なめると索引そのものより高くつく (Phase 3 の実機で実測)。
      CREATE INDEX documents_state ON documents (index_state);
    `
  },
  {
    version: 5,
    name: 'plugins',
    up: `
      -- Phase 4 (ARCHITECTURE.md 7 章 / 8 章)。プラグイン基盤の 4 テーブル。

      -- 監査ログ (8 章 / 7.7)。**置き場は暗号化 DB のテーブル** (ユーザ判断、12.9)
      -- — 制約 11 と一貫させ、平文ファイルにプラグイン ID とパスと URL が
      -- 積み上がるのを避けるため。
      -- **値は残さない**: target はパス / ホスト / source 名までで、
      -- 本文・引数・クエリは入れない (IMPLEMENTATION_BRIEF 7 章のログ規約)。
      CREATE TABLE audit_log (
        id         INTEGER PRIMARY KEY,
        at         INTEGER NOT NULL,
        plugin_id  TEXT NOT NULL,
        capability TEXT NOT NULL,
        op         TEXT NOT NULL,
        target     TEXT,
        -- 'allow' | 'deny'
        decision   TEXT NOT NULL,
        reason     TEXT,
        ms         INTEGER
      );
      -- 一覧は常に「新しい順に N 件」。**全件 COUNT はしない** (12.7 の教訓)。
      CREATE INDEX audit_log_at ON audit_log (at DESC, id DESC);
      CREATE INDEX audit_log_plugin ON audit_log (plugin_id, at DESC);

      -- プラグインの有効 / 無効 (7.1)。同梱プラグインは常に有効なので行を持たない。
      CREATE TABLE plugin_state (
        plugin_id  TEXT PRIMARY KEY,
        enabled    INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );

      -- 能力ごとのユーザ同意 (7.7)。マニフェストの宣言は「求めうる上限」で、
      -- 許可はここに記録する。設定画面で取り消せる。
      CREATE TABLE plugin_consents (
        plugin_id  TEXT NOT NULL,
        capability TEXT NOT NULL,
        -- 'granted' | 'denied'
        decision   TEXT NOT NULL,
        at         INTEGER NOT NULL,
        PRIMARY KEY (plugin_id, capability)
      );

      -- プラグイン由来の本文の**正本** (6.5)。
      -- 骨格の 8 章は cache/<plugin>/ というディレクトリを想定していたが、
      -- 平文ファイルとして置くと制約 11 (DB 全体を暗号化) と食い違う。
      -- 暗号化 DB の中に 1 か所だけ置く形にした (12.9)。
      -- documents は本文を持たず (制約 9)、chunks はここへのバイト範囲を指す。
      CREATE TABLE plugin_documents (
        source     TEXT NOT NULL,
        source_id  TEXT NOT NULL,
        title      TEXT NOT NULL,
        uri        TEXT NOT NULL,
        body       TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (source, source_id)
      );
    `
  },
  {
    version: 6,
    name: 'stale-sweep-indexes',
    up: `
      -- documents.parent_id は自分自身への外部キー (ON DELETE CASCADE) なので、
      -- 1 行消すたびに SQLite が「この行を親に持つ子」を引く。その索引が無かった。
      -- documents_tree は **部分索引** (WHERE source = 'fs') で、SQLite は外部キーの
      -- 子検索に部分索引を使えない。結果、1 行の削除が documents の全走査になり、
      -- 走査後の掃除 (IndexStore.removeStale) がメインスレッドを 100 秒止めた。
      --
      -- 30 万行での実測: 1,000 行の削除が 14.240 s → 0.032 s (445 倍)。
      -- parent_id は upsert で更新されないので、走査の書き込みは遅くならない
      -- (再走査 30 万件の upsert は 822 ms → 821 ms)。
      CREATE INDEX IF NOT EXISTS documents_parent ON documents (parent_id);

      -- 掃除の対象行そのものを引くための索引。無いと documents_tree を端から歩いて
      -- 1 行ずつ rowid 参照することになり、2.9 GB の暗号化 DB では表のほぼ全ページを
      -- ChaCha20 で復号する羽目になる。
      -- seen_at は走査のたびに全行書き換わるので、この索引だけは書き込みが増える
      -- (再走査 30 万件の upsert が 821 ms → 1,164 ms)。走査全体は実機 114 万件で
      -- 約 2 分なので、その中では誤差に埋もれる。
      CREATE INDEX IF NOT EXISTS documents_seen ON documents (source, seen_at);
    `
  },
  {
    version: 7,
    name: 'thread-defaults',
    up: `
      -- T5 (docs/TODO_PLAN.md、ARCHITECTURE.md 4.3.1 / 4.3.2)。
      -- スレッド作成時の model / thinking と、作業ディレクトリの履歴。
      -- backend 列は migration 2 に既にある。

      -- NULL = バックエンドの既定。id は不透明 (実文字列は compat/ だけが知る — 制約 6)。
      ALTER TABLE threads ADD COLUMN model_id TEXT;
      -- 中立語彙 'off' | 'low' | 'medium' | 'high'。NULL = 既定。
      ALTER TABLE threads ADD COLUMN thinking TEXT;

      -- 設定の出所 (4.2 / 4.6.2)。JSON 配列 ('user' | 'project' | 'local')。
      -- load_user_settings (真偽 1 つ) を置き換える: T0 で「"" は cwd の指示ファイルも
      -- 止める、project なら効く」と分かり、真偽では表せなくなった。
      -- 既存行: 0 (= "") は ["project"] に、1 (= 全部) は 3 つ全部に写す。
      -- 0 → ["project"] は挙動が変わる (指示ファイルが効き始める) が、それが T5 の目的。
      ALTER TABLE threads ADD COLUMN setting_sources TEXT NOT NULL DEFAULT '["project"]';
      UPDATE threads SET setting_sources =
        CASE WHEN load_user_settings = 1 THEN '["user","project","local"]' ELSE '["project"]' END;
      ALTER TABLE threads DROP COLUMN load_user_settings;

      -- 作業ディレクトリの履歴 (TODO 6)。パスは暗号化 DB の中だけ (制約 11)。
      -- renderer には file:// の URI と名前だけを渡す。
      CREATE TABLE cwd_history (
        path         TEXT PRIMARY KEY,
        last_used_at INTEGER NOT NULL,
        use_count    INTEGER NOT NULL DEFAULT 1
      );
    `
  },
  {
    version: 8,
    name: 'file-name-search',
    up: `
      -- T8 (docs/TODO_PLAN.md、ARCHITECTURE.md 6.6)。ファイル名検索を
      -- 「表の全走査」から「被覆部分索引の全走査」に変える。
      --
      -- 前提: 照合は qlm 流 (空白で分割 → 全語 AND → 連続一致 → tier で並べる) で、
      -- SQL には書けない。だから SQL に求めるのは「候補を安く端から配ること」だけで、
      -- 必要な列が索引に全部載っていれば表のページを 1 枚も復号せずに済む。
      -- 実機相当の規模での実測は 6.6 の表。
      --
      -- 列の順が (id, ...) なのは、キーセット送り (id > ? ORDER BY id LIMIT n) で
      -- ページに割るため。イテレータを開いたまま待つと同じ接続の書き込みが
      -- 止まるので、1 ページ = 1 文で完結させて間でイベントループに戻る。
      CREATE INDEX IF NOT EXISTS documents_name_scan
        ON documents (id, name, parent_id) WHERE source = 'fs';

      -- パス照合 (tier 2) 用。行は絶対パスを持たない (6.3) ので、
      -- ディレクトリ木を丸ごと読んでパスを組み立てる。ディレクトリだけの
      -- 部分索引なので実機で十数万行 (ファイルを含む全体の 1/8 程度)。
      CREATE INDEX IF NOT EXISTS documents_dir_tree
        ON documents (id, parent_id, name) WHERE source = 'fs' AND kind = 'directory';

      -- 旧ファイル名検索の索引。LIKE '%q%' には前方に % が付くので
      -- そもそも一度も使われていなかった (使えるのは前方一致だけ)。
      -- 名前の同一性は documents_tree (parent_id, name_folded) が見ているので、
      -- これを落としても引けなくなる問い合わせは無い。
      DROP INDEX IF EXISTS documents_name;
    `
  },
  {
    version: 9,
    name: 'approval-strict',
    up: `
      -- T12 (docs/TODO_PLAN_2.md、ARCHITECTURE.md 4.2「既定許可 / 停止パターン / 厳格モード」)。
      -- スレッドごとの厳格モード。1 なら既定許可リストも停止パターンも見ず、
      -- 届いた権限要求を全部インボックスに積む。既存行は 0 (既定を緩めた新しい挙動)。
      -- 既定許可リストと停止パターンそのものは app_settings
      -- (approval.autoAllowTools / approval.bashDenyPatterns) にあり、列は要らない。
      ALTER TABLE threads ADD COLUMN approval_strict INTEGER NOT NULL DEFAULT 0;
    `
  },
  {
    version: 10,
    name: 'approval-rules',
    up: `
      -- T22 (ARCHITECTURE.md 4.2.1)。「常に許可」で作った規則を再起動後も効かせる。
      -- T12 までは ApprovalBroker のメモリだけにあった。
      --
      -- **置き場をスレッドの行にした理由**: 規則の鍵は「スレッド × ツール名」
      -- (Bash はコマンド) で、**スレッドより長生きしうる規則は存在しない**。
      -- 行に持てば寿命がスレッドと一致し、DELETE FROM threads が規則も消す
      -- (掃除の経路が増えない / どのスレッドにも属さない規則が溜まらない)。
      -- app_settings の 1 キーに全スレッド分を JSON で置くと、消し忘れが
      -- 静かに積み上がり、それを掃く処理をもう 1 つ抱えることになる。
      --
      -- 中身は JSON 配列で、1 要素が {id, toolName, command, createdAt}。
      -- **threadId と threadTitle は入れない** — 行そのものが持っているので、
      -- 読むときに補う (スレッドを改名しても規則の表示が古い名前で残らない)。
      -- 壊れた値は空配列として扱う (規則が消えるだけで、承認を求める側に倒れる)。
      ALTER TABLE threads ADD COLUMN approval_rules TEXT NOT NULL DEFAULT '[]';
    `
  },
  {
    version: 11,
    name: 'approval-rules-global',
    up: `
      -- T40 (ARCHITECTURE.md 4.2.1.1、オーナー判断 2026-09-22)。承認規則を
      -- **アプリ全体の 1 つの表**にした。スレッドは短命なので、スレッドに紐づけると
      -- 新しいスレッドを立てるたびに同じ承認をやり直すことになっていた。
      --
      -- 新しい置き場は app_settings の approval.rules (既定許可リストと同じ場所)。
      -- migration 10 が足した列は**捨てる**: 中身を移すと、あるスレッドで 1 回押した
      -- 許可が全スレッドに広がる。押し直しは 1 回で済むので、移行しないほうが安全側。
      -- 列を残すと「読んでいないのに値がある」状態が続くので、列ごと落とす
      -- (DROP COLUMN は SQLite 3.35 以降。ここは 3.53.4)。
      ALTER TABLE threads DROP COLUMN approval_rules;
    `
  },
  {
    version: 12,
    name: 'thread-viewer-state',
    up: `
      -- 項目 63 (ARCHITECTURE.md 5.3「スレッドごとの表示の記憶」)。スレッドごとに
      -- ViewerPane で最後に見ていたファイルと、そのときの File 内検索の語 (項目 56) を覚える。
      -- スレッドの行に置くので、行を消せば記憶も消え、掃除の論点は無い。
      --
      -- last_viewer_uri: file: の URI。NULL = 何も開いていない (閉じるボタンで閉じた状態を含む)。
      -- last_viewer_highlight: 検索語。NULL = ハイライト無し。uri が NULL なら必ず NULL。
      ALTER TABLE threads ADD COLUMN last_viewer_uri TEXT;
      ALTER TABLE threads ADD COLUMN last_viewer_highlight TEXT;
    `
  },
  {
    version: 13,
    name: 'thread-soft-delete',
    up: `
      -- 項目 64 (ARCHITECTURE.md 4.3.3、オーナー決定 2026-09-23)。スレッドの削除を
      -- 論理削除にする。削除は DELETE ではなく deleted_at に時刻を書くだけで、
      -- threads / sessions / thread_events の行は残る。NULL = 生きている。
      --
      -- archived (migration 1、書き手が無い) は転用しない: 将来の「整理のための
      -- アーカイブ」と「消した」が 1 列に同居するのを避ける。物理 purge は作らないので
      -- threads 表は縮まない。一覧の絞り込みは archived = 0 AND deleted_at IS NULL。
      ALTER TABLE threads ADD COLUMN deleted_at INTEGER;
    `
  },
  {
    version: 14,
    name: 'thread-summary-columns',
    up: `
      -- 項目 75 (ARCHITECTURE.md 4.3「スレッド一覧の配信」)。サイドバーの 1 行に要る
      -- 累積 (turns / cost_usd) と 1 行プレビューをスレッドの行に持つ。以前は一覧を
      -- 配るたびにスレッドごとに sessions の SUM と thread_events の末尾 1 行を引いていた
      -- (2N+1 文が main の JS スレッドで、毎イベント)。
      --
      -- 書き手: ThreadStore.addTurn (turns / cost_usd) と appendEvents / clearTimeline /
      -- applyRetention (preview)。sessions の turns / cost_usd はセッション単位の内訳として残す。
      -- preview は正規化 (空白の畳み込みと 120 文字の切り詰め) 前の文でもよく、読む側
      -- (ThreadStore) が毎回正規化する。下の埋め戻しは SQL で正規化できないので長めに切るだけ。
      ALTER TABLE threads ADD COLUMN turns INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE threads ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
      ALTER TABLE threads ADD COLUMN preview TEXT;

      UPDATE threads SET turns = s.turns, cost_usd = s.cost
      FROM (
        SELECT thread_id, SUM(turns) AS turns, SUM(cost_usd) AS cost
        FROM sessions GROUP BY thread_id
      ) AS s
      WHERE threads.id = s.thread_id;

      -- 壊れた payload で json_extract が投げて migration ごと落ちないよう json_valid で守る。
      UPDATE threads SET preview = p.text
      FROM (
        SELECT thread_id,
               CASE WHEN json_valid(payload)
                    THEN substr(json_extract(payload, '$.text'), 1, 480) END AS text
        FROM (
          SELECT thread_id, payload,
                 ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY seq DESC) AS rn
          FROM thread_events
          WHERE kind IN ('assistant_text', 'user_text')
        )
        WHERE rn = 1
      ) AS p
      WHERE threads.id = p.thread_id;
    `
  },
  {
    version: 15,
    name: 'thread-columns-and-cleanup',
    up: `
      -- 項目 83 / 84 (ARCHITECTURE.md 4.3 / 4.3.3 / 6.2、オーナー決定 2026-09-23)。
      -- 2 つの項目で 1 本 (番号は 1 つ)。

      -- ---- 項目 83: スレッド行の意味の整理 ----
      --
      -- title_auto: 1 = 題名はまだ作成時の仮題で、次の送信の最初の行から名付けてよい。
      -- 以前は既定題の文字列一致で判定していて、ユーザが手でその題名を付けると次の送信で
      -- 上書きされた。既存行は「いまの題名が既定題そのもの」なら 1 に埋める (文字列は
      -- 当時 manager.ts が書いていた仮題。この埋め戻しの 1 回だけ文字列を見る。TODO 66 以降の
      -- 新しい行は仮題を空文字列で書き、読む側は title_auto = 1 の行の題名を空として返す)。
      ALTER TABLE threads ADD COLUMN title_auto INTEGER NOT NULL DEFAULT 0;
      UPDATE threads SET title_auto = 1 WHERE title = '新しいスレッド';

      -- 一覧の並びを updated_at から切り離す。updated_at は「行を触った時刻」に戻り、
      -- 並びは COALESCE(last_event_at, created_at) の新しい順 (既読にする・厳格モードを
      -- 切り替えるだけで先頭へ跳ねていた)。旧索引は archived を含むので、列より先に落とす。
      DROP INDEX IF EXISTS threads_updated;
      -- 同じ順を表す式索引。一覧の WHERE deleted_at IS NULL と同じ条件の部分索引にし、
      -- ORDER BY の式とタイブレーク (rowid) を逆向きに歩けば一時 B-tree が要らない。
      CREATE INDEX threads_recent ON threads (COALESCE(last_event_at, created_at))
        WHERE deleted_at IS NULL;

      -- thread_events.session_id は「そのイベントを生んだ aios 内部のセッション id」
      -- (プロセス 1 本ごとに振る) のまま使う。--resume の後は sessions.id (最初の内部 id が
      -- ON CONFLICT で残る) と一致しないので、sessions と結ぶ列ではない。誰も結ばない。

      -- ---- 項目 84: 書き手だけ / 読み手だけの列・表 ----
      --
      -- threads.archived: 書き手が無かった (項目 64 の「将来のため」を撤回)。
      ALTER TABLE threads DROP COLUMN archived;
      -- index_runs: 一度も書かれず読まれない表。
      DROP TABLE IF EXISTS index_runs;
      -- documents.sensitivity: 誰も読み書きしない。DROP COLUMN は表全体を書き直すので、
      -- 実機規模 (100 万行超) では起動が 1 回だけ数秒止まる (scripts/bench/migration-15.mts:
      -- 合成 115 万行・365 MB の暗号化 DB で 2.5 s)。
      ALTER TABLE documents DROP COLUMN sensitivity;

      -- cwd_history: path が主キーで畳み込んでいなかったので、大小違いの同じディレクトリが
      -- 2 行になっていた。畳み込んだ値を主キーにし、表示用の path は別の列に持つ。
      -- aios_fold_path は runMigrations が登録する関数 (common/uri.ts の foldPath そのもの)。
      -- 重複は 1 行に寄せる: 回数は足し、時刻と表示用の path は最後に使った行のもの。
      CREATE TABLE cwd_history_folded (
        path_folded  TEXT PRIMARY KEY,
        path         TEXT NOT NULL,
        last_used_at INTEGER NOT NULL,
        use_count    INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO cwd_history_folded (path_folded, path, last_used_at, use_count)
        SELECT aios_fold_path(path), path, MAX(last_used_at), SUM(use_count)
        FROM cwd_history GROUP BY aios_fold_path(path);
      DROP TABLE cwd_history;
      ALTER TABLE cwd_history_folded RENAME TO cwd_history;

      -- scan_denials: 残して読む口を足す (TCC 常設バナー 12.8 の材料)。行はパスごとに 1 つ
      -- だが、拒否されたパスが増えるほど増え続けたので、新しい 1,000 行だけ残す。
      -- 書き手は索引プロセスの FsIndexer だけ。上限はこのトリガーで守る (書き手の側に
      -- 掃除の処理を足さない)。拒否は走査 1 回に数件なので、挿入ごとの COUNT は安い。
      -- ON CONFLICT DO UPDATE は INSERT トリガーを起こさない (行が増えないので正しい)。
      DELETE FROM scan_denials WHERE path_folded NOT IN (
        SELECT path_folded FROM scan_denials ORDER BY seen_at DESC LIMIT 1000
      );
      CREATE INDEX scan_denials_seen ON scan_denials (seen_at);
      CREATE TRIGGER scan_denials_cap AFTER INSERT ON scan_denials
      WHEN (SELECT COUNT(*) FROM scan_denials) > 1000
      BEGIN
        DELETE FROM scan_denials WHERE path_folded IN (
          SELECT path_folded FROM scan_denials ORDER BY seen_at, path_folded
          LIMIT (SELECT COUNT(*) - 1000 FROM scan_denials)
        );
      END;
    `
  },
  {
    version: 16,
    name: 'thread-fork-origin',
    up: `
      -- 項目 113 (ARCHITECTURE.md 4.5.6): 巻き戻しで分岐して作ったスレッドの出自。
      -- JSON 1 つ {threadId, eventId, files, backendSessionId, atMessageId}。
      -- 元のスレッドと発言 (renderer の帯とジャンプ先)、ファイルも戻したか、そして最初の起動で
      -- 「元のセッションを、その応答までの会話から、別のセッションとして再開する」ための
      -- バックエンドのセッション id と応答の識別子。最初の session_started で sessions の行が
      -- 入った後は起動に使わない (以後は普通の再開)。普通に作ったスレッドは NULL。
      -- 発言の識別子そのものは thread_events.payload の messageId (user_text / assistant_text /
      -- tool_use) で、列は増やさない (行の JSON に足すだけなので migration は要らない)。
      ALTER TABLE threads ADD COLUMN fork_origin TEXT;
    `
  },
  {
    version: 17,
    name: 'thread-transcript-origin',
    up: `
      -- 項目 111 (ARCHITECTURE.md 4.5.9): ターミナル / VS Code で始めた会話 (バックエンドの転写)
      -- から続けたスレッドの出自。JSON 1 つ {sessionId, fileId, limit, fork}。
      -- sessionId は元の会話のバックエンドのセッション id (同じ id で続けるときの --resume の材料)、
      -- fileId は転写ファイルの不透明な id (場所の知識は adapter だけ)、limit は続けた時点の
      -- ファイルの大きさ (バイト) = 過去分の読みどめ。それより後の行は aios 自身の thread_events に
      -- あるので、過去分として二重に出さない。fork が真なら別のセッションとして分岐した
      -- (--fork-session)。過去分は転写をその都度読んで出し、この DB には取り込まない (制約 9 / 10)。
      -- 普通に作ったスレッドは NULL。
      ALTER TABLE threads ADD COLUMN transcript_origin TEXT;
    `
  },
  {
    version: 18,
    name: 'scheduled-jobs',
    up: `
      -- TODO 323 第 1 段 (ARCHITECTURE.md 6.2.4、第 18 波 束 A): 定期実行のジョブ。
      -- 書き手は main の ScheduledJobStore だけ (索引プロセスは触らない)。
      -- spec / action は JSON (shared/schedule.ts の ScheduleSpec / 種類ごとの中身)。
      -- action の cwd は main のパス (renderer には URI で渡す)。プロンプトは利用者が書いた設定で、
      -- 会話ではないので redaction は通さない (DB は全体が暗号化、制約 11)。
      -- anchor_at: 「この時刻より後の最初の予定が来たら走る」の基準。作成・時刻の変更・有効化・
      -- 定時に走らせた / 飛ばしたときに今へ進める (止まっていた間に何回分逃しても 1 回だけ追いつく)。
      CREATE TABLE scheduled_jobs (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        enabled        INTEGER NOT NULL DEFAULT 1,
        kind           TEXT NOT NULL,
        spec           TEXT NOT NULL,
        action         TEXT NOT NULL,
        anchor_at      INTEGER NOT NULL,
        last_run_at    INTEGER,
        last_thread_id TEXT,
        last_outcome   TEXT,
        last_error     TEXT,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );
      -- 定時プロンプトが起こしたスレッドの印 (一覧の ⏰)。ジョブを消しても印は残る。
      ALTER TABLE threads ADD COLUMN schedule_job_id TEXT;
    `
  },
  {
    version: 19,
    name: 'scheduled-jobs-last-skip-at',
    up: `
      -- TODO 351 の観察 (第 18 波 束 D): 「前回」(last_run_at、走った回) と「飛ばしました」
      -- (recordSkip が結果だけ書き換え、last_run_at は動かさない) が別の回を指して読める件。
      -- 飛ばした回そのものの予定時刻を別の列に持ち、一覧で両方の時刻を出す。
      ALTER TABLE scheduled_jobs ADD COLUMN last_skip_at INTEGER;
    `
  },
  {
    version: 21,
    name: 'thread-interrupted',
    up: `
      -- TODO 521 (第 26 波 束 B): 回答が途中で止まった印。値は理由コード (shared/reason.ts の
      -- interrupt-*) で、NULL は止まっていない。書き手は main の SessionManager だけ
      -- (失敗の result・ターン中のプロセスの終わりで立て、次のターンが正常に始まったら消す)。
      -- 本文は持たない (制約 9 / 10)。20 は欠番 (束 A は 21 が先に main に入ったので 22 にした)。
      ALTER TABLE threads ADD COLUMN interrupted TEXT;
    `
  },
  {
    version: 22,
    name: 'web-history-favorites',
    up: `
      -- TODO 522 (ARCHITECTURE.md 5.2.1、第 26 波 束 A。番号は 20 の予定だったが、21 (束 B) が先に main に入った。
      -- 21 まで上がった DB では 20 が黙って skip されるので 22 にした): Sidebar の web モードの履歴と Favorite。
      -- 書き手は main の WebDataStore だけ (索引プロセスは触らない)。題名・URL・時刻だけで、ページの本文は持たない。
      -- URL は保存の前に persistableWebUrl (redaction の表に当たればクエリを落とす、それでも当たれば残さない) を通す。
      -- 履歴は URL ごとに 1 行 (開くたびに visited_at を進める)。上限は 1,000 行 / 90 日 (古いものから消す)。
      CREATE TABLE web_history (
        id         INTEGER PRIMARY KEY,
        url        TEXT NOT NULL UNIQUE,
        title      TEXT NOT NULL DEFAULT '',
        visited_at INTEGER NOT NULL
      );
      CREATE INDEX web_history_visited ON web_history(visited_at);
      -- Favorite は利用者が ☆ で足したもの。並びは position (drag で並べ替える)。フォルダは持たない。
      CREATE TABLE web_favorites (
        id         INTEGER PRIMARY KEY,
        url        TEXT NOT NULL UNIQUE,
        title      TEXT NOT NULL DEFAULT '',
        position   INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `
  },
  {
    version: 23,
    name: 'thread-worktrees',
    up: `
      -- TODO 633 段 1 / 700 (第 33 波 束 A、ARCHITECTURE 4.4)。書き手は main の SessionManager だけ。
      -- worktree_cwd: 会話の途中で worktree に移ったら、その worktree のパス (NULL = 元の cwd のまま)。
      -- Files・BottomBar の git の要約・再開 (--resume の cwd) がこちらを見る。一覧の組は cwd のまま。
      -- outside_write_at: worktree で分けた回に worktree の外 (本体の作業コピー) への書き込みを最後に見た時刻 (700)。
      ALTER TABLE threads ADD COLUMN worktree_cwd TEXT;
      ALTER TABLE threads ADD COLUMN outside_write_at INTEGER;
      -- その会話が作った worktree (移った先・worktree で走った子・起動の指定)。会話を消すときの片付けの対象。
      -- 片付けで消したら行も消す。残したら kept に理由 (changes / unpushed / locked / failed / unsafe) を書く。
      -- パスとブランチだけで、中身は持たない (制約 9 / 10)。
      CREATE TABLE thread_worktrees (
        thread_id  TEXT NOT NULL,
        path       TEXT NOT NULL,
        branch     TEXT,
        origin     TEXT NOT NULL,
        repo_cwd   TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        kept       TEXT,
        PRIMARY KEY (thread_id, path)
      );
    `
  },
  {
    version: 24,
    name: 'thread-worktrees-restore',
    up: `
      -- TODO 633 の code-review の直し (第 33 波、ARCHITECTURE 4.4)。書き手は main の SessionManager だけ。
      -- removed_head: 片付けで消した worktree の HEAD の commit。会話の復元のとき、同じパス・同じブランチ名で
      -- この commit から作り直す (オーナー決定 2026-10-11)。NULL = 消していない (生きている・残した)。
      -- 消した行は表に残す (以前は消したら行も消していた)。
      ALTER TABLE thread_worktrees ADD COLUMN removed_head TEXT;
      -- worktree_lost: 復元のときに作り直せなかった worktree のパス。会話は元の cwd に戻し、一覧の行に印を出す
      -- (ダイアログは出さない — TODO 167)。次に worktree に入ったら消す。
      ALTER TABLE threads ADD COLUMN worktree_lost TEXT;
    `
  },
  {
    version: 25,
    name: 'scheduled-jobs-max-runs',
    up: `
      -- TODO 725 (第 34 波 束 A、ARCHITECTURE.md 6.2.4): 定期実行の回数の上限。書き手は main の
      -- ScheduledJobStore だけ。max_runs: null = 無制限。run_count: 実際に走った回数 (飛ばした・
      -- 未対応の回は数えない)。有効 → 無効 → 有効と切り替えると run_count は 0 から数え直す
      -- (ScheduledJobStore.updateJob)。「1 回だけ」(spec.kind === 'once') には適用しない — 常に null。
      ALTER TABLE scheduled_jobs ADD COLUMN max_runs INTEGER;
      ALTER TABLE scheduled_jobs ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0;
    `
  },
  {
    version: 26,
    name: 'web-favicons',
    up: `
      -- TODO 722 (第 34 波 束 B、ARCHITECTURE 5.2.1): 履歴 / Favorite の行に favicon を出す。
      -- favicon は**ホスト単位**で持つ (履歴と Favorite で共用、タブの favicon — 579 — とは別口)。
      -- host は書き込み時 (recordVisit / addFavorite(sBatch)) に aios_web_host(url) で埋める。
      -- 既存の行は NULL のままなので、この migration でまとめて埋める (下の UPDATE)。
      CREATE TABLE web_favicons (
        host       TEXT PRIMARY KEY,
        icon       TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      ALTER TABLE web_history ADD COLUMN host TEXT;
      ALTER TABLE web_favorites ADD COLUMN host TEXT;
      CREATE INDEX web_history_host ON web_history(host);
      CREATE INDEX web_favorites_host ON web_favorites(host);
      UPDATE web_history SET host = aios_web_host(url) WHERE host IS NULL;
      UPDATE web_favorites SET host = aios_web_host(url) WHERE host IS NULL;
    `
  },
  {
    version: 27,
    name: 'web-favicons-failed-at',
    up: `
      -- TODO 743 (第 35 波 束 A、ARCHITECTURE 5.2.1): Favorite の favicon を起動時に裏で埋め直す。
      -- 失敗したホストは 7 日は取り直さない。icon は NOT NULL のままにし (アプリ全体で「icon が無い行」の
      -- 意味を増やさない)、失敗の記録は空文字列の icon + この failed_at で区別する
      -- (WebDataStore.markFaviconFailed / hostsWithoutFavicon、本物の icon を持つ行は上書きしない)。
      ALTER TABLE web_favicons ADD COLUMN failed_at INTEGER;
    `
  },
  {
    version: 28,
    name: 'thread-viewer-history',
    up: `
      -- TODO 772 (第 36 波 束 B、ARCHITECTURE 5.3): viewer の「← →」の履歴を会話ごとに残す。書き手は main の
      -- ViewerHistoryService だけ。history は {entries:[{uri,highlight}], index} の JSON (直近 50 歩まで、本文は持たない)。
      -- threads の列にしなかったのは、行を読むたび (一覧の配信) に数 KB を運ばないため。別の表 + 外部キーなので
      -- 3 分の物理削除 (526) の DELETE FROM threads と一緒に消える (論理削除では残り、復元で戻る)。
      CREATE TABLE thread_viewer_history (
        thread_id  TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        history    TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `
  },
  {
    version: 29,
    name: 'clip-permission-request-input',
    up: `
      -- TODO 838: 承認要求 (permission_request) の payload.input は Write の全文などが丸ごと残っていた
      -- (4.3.1 の「引数の巨大な本文は保存しない」に反し、制約 9 にも反する)。保存時の規則 (文字列 1 本 1,000 字・
      -- 配列 50 件) で既存の行も切り詰め直す。対象は長い行だけ。redaction 済みなので再 redaction はしない。
      -- 容量は VACUUM するまで戻らない (自動ではやらない)。
      -- 大きな payload の JSON の解析は 1 行 1 回にするため、payload_bytes は書き直した後の値から別の文で出す。
      UPDATE thread_events
         SET payload = aios_clip_permission_payload(payload)
       WHERE kind = 'permission_request' AND length(payload) > 2000;
      UPDATE thread_events
         SET payload_bytes = length(CAST(payload AS BLOB))
       WHERE kind = 'permission_request' AND payload_bytes <> length(CAST(payload AS BLOB));
    `
  },
  {
    version: 30,
    name: 'chunk-id-high-water',
    up: `
      -- TODO 965 (第 51 波 束 D): chunks.id (= chunk_fts の rowid) を再利用しない。chunks.id は INTEGER PRIMARY KEY で
      -- AUTOINCREMENT ではないので「最大 + 1」になり、上の方の行が消えると同じ rowid が別の文書に配られる。contentless の
      -- chunk_fts に既にある rowid で INSERT しても誤りにならず、前の語が残ったまま足される (消えたファイルの語が別の文書に当たる)。
      -- しかも前の語は二度と消せない (DELETE は最後に入れた版にしか tombstone を置かない。docs/notes/wave51.md)。
      -- AUTOINCREMENT にするには表を作り直すしかなく (710 万行を main で複写する)、ここでは 1 行の高水位の表を足すだけにする。
      -- 書き手は索引プロセスの IndexStore だけ (replaceChunks が last_id より上の id を自分で振り、last_id を進める)。
      -- rebuild_below: 高水位の種 (= この表ができた時点の chunks / chunk_fts の最大の id)。これ以下の id のチャンクを持つ文書は
      -- rowid の再利用で FTS が汚れている可能性があり、索引プロセスのアイドル (upkeep.ts) が少しずつ索引し直す。
      -- **ここでは表を作るだけで、種は索引プロセスが開いたときに入れる** (IndexStore.seedChunkIdSeq)。main の JS スレッドで
      -- 索引の表を読まない (制約 8.1、test/index-bundle.test.ts)。chunks に書くのは索引プロセスだけなので、migration から
      -- 索引プロセスが開くまでの間に id は動かず、種は同じになる。
      -- 冪等にしておく (user_version を戻して当て直すテストがある)。
      CREATE TABLE IF NOT EXISTS chunk_id_seq (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        last_id       INTEGER NOT NULL,
        rebuild_below INTEGER NOT NULL
      );
    `
  },
  {
    version: 31,
    name: 'documents-recent',
    up: `
      -- TODO 999 (第 53 波 束 B) は、ここで「最近のファイル」の部分索引 documents_recent を作っていた。修正束 X (review) で
      -- 中身を外した: migration は main の JS スレッドで走り、100 万行を超える documents の CREATE INDEX は数秒 main を握る
      -- (制約 8.1 の「main で索引の SQL を 1 文も実行しない」に反する)。索引は索引プロセスの IndexStore が開くときに
      -- CREATE INDEX IF NOT EXISTS で作る (IndexStore.ensureRecentIndex)。番号は振り直さない (使用済み、phase0-4.md):
      -- 既に 31 を当てた DB は索引を持っていて IF NOT EXISTS が素通りし、まだの DB は user_version を 31 に上げるだけ。
      SELECT 1;
    `
  },
  {
    version: 32,
    name: 'scheduled-jobs-strict-off',
    up: `
      -- TODO 1015 (第 55 波): 定時ジョブの厳格モードの既定を OFF に戻した (959 の「既定 ON」を覆す)。959 以降に作ったジョブは
      -- 「既定の ON のまま」の疑いが強く、保存値だけでは利用者が付けたか区別できないので、保存済みの prompt のジョブを一律 false にする
      -- (オーナー決定 2026-10-26)。送信 (outbound) は厳格でなくても必ず聞く。
      UPDATE scheduled_jobs
         SET action = json_set(action, '$.approvalStrict', json('false'))
       WHERE kind = 'prompt' AND json_valid(action);
    `
  },
  {
    version: 33,
    name: 'plugin-task-state',
    up: `
      -- TODO 952 段 1 (第 56 波 束 A): plugin の定期タスクが持ち回る状態 (続きの位置。aios.gmail なら historyId と
      -- 全件の取り込みの pageToken)。plugin は自前で状態を持たず、タスクの戻り値の state を main がここに置き、
      -- 次の呼び出しの引数で返す。本文は入れない (正本は plugin_documents、制約 9)。plugin を消した・ログアウトで消す。
      CREATE TABLE IF NOT EXISTS plugin_task_state (
        plugin_id  TEXT NOT NULL,
        task_id    TEXT NOT NULL,
        state      TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (plugin_id, task_id)
      );
    `
  },
  {
    version: 34,
    name: 'thread-os-sandbox',
    up: `
      -- TODO 1106 (第 68 波 束 A、ARCHITECTURE 4.2.4): スレッドごとの OS の sandbox (バックエンドを sandbox を有効にして起こす)。
      -- 既存の行は OFF (対話のスレッドの既定)。無人のスレッド (定時ジョブ) は作るときに ON にする (オーナー決定 2026-11-03)。
      ALTER TABLE threads ADD COLUMN os_sandbox INTEGER NOT NULL DEFAULT 0;
    `,
    skipIfColumn: { table: 'threads', column: 'os_sandbox' }
  },
  {
    version: 35,
    name: 'triggers',
    up: `
      -- TODO 1216 (第 84 波 束 A、ARCHITECTURE 6.2.6): トリガー。拡張機能が知らせた出来事 1 件につき 1 つの無人の会話を起こす。
      -- trigger_rules: 利用者の規則 (trigger ごと)。既定は無効。capped_* は「今日、上限で見送った件数」(持ち越さない)。
      CREATE TABLE IF NOT EXISTS trigger_rules (
        plugin_id    TEXT NOT NULL,
        trigger_id   TEXT NOT NULL,
        enabled      INTEGER NOT NULL DEFAULT 0,
        instructions TEXT,
        cwd          TEXT,
        model_id     TEXT,
        thinking     TEXT,
        daily_cap    INTEGER NOT NULL DEFAULT 20,
        capped_day   TEXT,
        capped_count INTEGER NOT NULL DEFAULT 0,
        updated_at   INTEGER NOT NULL,
        PRIMARY KEY (plugin_id, trigger_id)
      );
      -- trigger_events: 重複排除と 1 日の件数。鍵は SHA-256 だけ (中身は持たない)。題・参照の文・本文は持たない (制約 9)。
      -- state: queued / started / failed / gave-up。古い行は日数で掃く (TriggerStore.sweep)。
      CREATE TABLE IF NOT EXISTS trigger_events (
        id          INTEGER PRIMARY KEY,
        plugin_id   TEXT NOT NULL,
        trigger_id  TEXT NOT NULL,
        key_hash    TEXT NOT NULL,
        thread_id   TEXT,
        state       TEXT NOT NULL,
        attempts    INTEGER NOT NULL DEFAULT 0,
        reason      TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS trigger_events_key ON trigger_events (plugin_id, trigger_id, key_hash);
      CREATE INDEX IF NOT EXISTS trigger_events_created ON trigger_events (plugin_id, trigger_id, created_at);
      -- 会話の出所の印 (JSON: pluginId / triggerId / url)。一覧の印と見出しのリンク。NULL = 普通の会話。
      ALTER TABLE threads ADD COLUMN trigger_origin TEXT;
    `,
    // The column and two tables go in the same transaction, so if the column exists the tables do too (for the test that rewinds the number and applies again).
    skipIfColumn: { table: 'threads', column: 'trigger_origin' }
  },
  {
    version: 36,
    name: 'trigger-events-pending',
    up: `
      -- 第 84 波 直し V (code-review、ARCHITECTURE 6.2.6): 受け付けたがまだ起こしていない出来事の中身 (JSON: title / url / cwd /
      -- prompt。鍵は持たない。title / prompt は redaction の後)。アプリの終了をまたいで待ち行列に戻すため。起こした・諦めた・
      -- 捨てたら NULL に戻す (中身を持つのは待っている間だけ)。
      ALTER TABLE trigger_events ADD COLUMN pending TEXT;
    `,
    skipIfColumn: { table: 'trigger_events', column: 'pending' }
  },
  {
    version: 37,
    name: 'thread-auto-pick-recommended',
    up: `
      -- TODO 1222 (第 85 波 束 B、ARCHITECTURE 4.2.2): 質問の推奨の自動選択を会話ごとに持つ。既定は OFF。
      -- 以前の全体の設定 (app_settings の approval.autoPickRecommended) の値は引き継がない (読まなくなるだけ)。
      ALTER TABLE threads ADD COLUMN auto_pick_recommended INTEGER NOT NULL DEFAULT 0;
    `,
    skipIfColumn: { table: 'threads', column: 'auto_pick_recommended' }
  },
  {
    version: 38,
    name: 'trigger-rules-allowed-tools',
    up: `
      -- TODO 1227 (第 85 波 束 D、ARCHITECTURE 6.2.6): 無人の読み取り専用のターンで通してよい、その規則の出来事を出した
      -- 同梱でない拡張機能自身の道具の名前 (JSON の文字列の配列)。NULL / 空 = 何も通さない (既定)。利用者が規則の編集で選ぶ。
      ALTER TABLE trigger_rules ADD COLUMN allowed_tools TEXT;
    `,
    skipIfColumn: { table: 'trigger_rules', column: 'allowed_tools' }
  },
  {
    version: 39,
    name: 'trigger-rules-owner',
    up: `
      -- TODO 1227 直し X (第 85 波、セキュリティレビュー、ARCHITECTURE 6.2.6): 規則を有効にした・道具を許したときの拡張機能の
      -- 同一性 (main が持つ事実: 同梱は 'bundled'、外は拡張機能のディレクトリ全体の中身の SHA-256)。起動時と出来事を受けるときに
      -- 今の同一性と比べ、違えば (読み込めなかった・入れ替わった・更新された外の拡張機能) 規則を無効に戻し道具の許可を外す。
      -- auto_disabled はそのときの理由 ('plugin-missing' / 'plugin-changed')。利用者が規則を書けば NULL に戻る。行は消さない。
      ALTER TABLE trigger_rules ADD COLUMN owner_identity TEXT;
      ALTER TABLE trigger_rules ADD COLUMN auto_disabled TEXT;
    `,
    skipIfColumn: { table: 'trigger_rules', column: 'owner_identity' }
  },
  {
    version: 40,
    name: 'plugin-consents-owner',
    up: `
      -- TODO 1233 (第 86 波 束 A、ARCHITECTURE 7.7): 同意を決めたときの拡張機能の同一性 (trigger_rules.owner_identity と同じ値:
      -- 同梱は 'bundled'、外は拡張機能のディレクトリ全体の中身の SHA-256)。同意が効くのは今の同一性と同じ行だけ
      -- (同じ id を名乗る別物・中身の変わった外の拡張機能は同意をやり直す)。NULL (この migration より前の行) は、
      -- 今が同梱なら 'bundled' を書き足し、外なら効かない (同意をやり直す)。
      ALTER TABLE plugin_consents ADD COLUMN owner_identity TEXT;
    `,
    skipIfColumn: { table: 'plugin_consents', column: 'owner_identity' }
  },
  {
    version: 41,
    name: 'plugin-state-owner',
    up: `
      -- TODO 1237 (第 87 波 束 D、ARCHITECTURE 7.2 / 7.7): 有効 / 無効を決めたときの拡張機能の同一性 (plugin_consents.owner_identity と
      -- 同じ値: 同梱は 'bundled'、外は拡張機能のディレクトリ全体の中身の SHA-256)。行が効くのは今の同一性と同じときだけ
      -- (同じ id を名乗る別物・中身の変わった外の拡張機能は既定に戻る)。NULL (この migration より前の行) は、今が同梱なら
      -- 'bundled' を書き足し、外なら無効の行だけ最初の計算で今の同一性を書き足す (閉じる側)。
      ALTER TABLE plugin_state ADD COLUMN owner_identity TEXT;
      -- アンインストールの目印。ディレクトリを捨てた後で行を消す transaction が失敗したときに残り、次の起動で行・正本・索引の文書を
      -- 片付けるまで消えない (フォルダがゴミ箱にあるのに同意・規則・設定が効き直さない)。
      CREATE TABLE IF NOT EXISTS plugin_uninstall_pending (
        plugin_id TEXT PRIMARY KEY,
        at        INTEGER NOT NULL
      );
    `,
    skipIfColumn: { table: 'plugin_state', column: 'owner_identity' }
  },
  {
    version: 42,
    name: 'plugin-rows-per-owner',
    up: `
      -- TODO 1246 (第 89 波 束 B、ARCHITECTURE 7.2 / 7.7): 有効 / 無効と同意を**同一性ごとの行**で持つ。主キーに owner_identity を足し、
      -- 同梱 ('bundled') と外 (SHA-256) が同じ id でも別の行になる (片方の書き込みがもう片方の無効・拒否を上書きしない)。
      -- owner_identity は NOT NULL — migration 40 / 41 より前の行 (NULL) は '' (同一性なし) に移す。コードは '' を null と読む。
      -- 表の作り直し。途中で止まった跡 (_new が残る) は先に捨て、すでに作り直した表にもう一度流しても同じ結果になる (COALESCE は無害)。
      DROP TABLE IF EXISTS plugin_state_new;
      CREATE TABLE plugin_state_new (
        plugin_id      TEXT NOT NULL,
        enabled        INTEGER NOT NULL DEFAULT 1,
        updated_at     INTEGER NOT NULL,
        owner_identity TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (plugin_id, owner_identity)
      );
      INSERT INTO plugin_state_new (plugin_id, enabled, updated_at, owner_identity)
        SELECT plugin_id, enabled, updated_at, COALESCE(owner_identity, '') FROM plugin_state;
      DROP TABLE plugin_state;
      ALTER TABLE plugin_state_new RENAME TO plugin_state;

      DROP TABLE IF EXISTS plugin_consents_new;
      CREATE TABLE plugin_consents_new (
        plugin_id      TEXT NOT NULL,
        capability     TEXT NOT NULL,
        decision       TEXT NOT NULL,
        at             INTEGER NOT NULL,
        owner_identity TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (plugin_id, capability, owner_identity)
      );
      INSERT INTO plugin_consents_new (plugin_id, capability, decision, at, owner_identity)
        SELECT plugin_id, capability, decision, at, COALESCE(owner_identity, '') FROM plugin_consents;
      DROP TABLE plugin_consents;
      ALTER TABLE plugin_consents_new RENAME TO plugin_consents;
    `
  },
  {
    version: 43,
    name: 'role-grants',
    up: `
      -- TODO 983 段 1 (第 89 波 束 A、ARCHITECTURE 4.2.5): role ごとの許可の表。段 1〜3 の role は定時ジョブ 1 つ (role_key = 'job:<jobId>')。
      -- 承認の枠の「この role には今後も許す」で行が増える。値は redaction の後だけ (command-exact の照合は hash)。tool_result は持たない。
      -- 書き手は main の RoleGrantStore だけ。行は読むたびに検証し、食い違う行は効かない (閉じる側)。
      CREATE TABLE IF NOT EXISTS role_grants (
        id           TEXT PRIMARY KEY,
        role_key     TEXT NOT NULL,
        tool_name    TEXT NOT NULL,
        subject_kind TEXT NOT NULL,
        subject      TEXT,
        subject_hash TEXT,
        access       TEXT,
        scope        TEXT NOT NULL,
        thread_id    TEXT,
        expires_at   INTEGER,
        source       TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER,
        use_count    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS role_grants_role ON role_grants (role_key);
    `
  },
  {
    version: 44,
    name: 'scheduled-jobs-snooze',
    up: `
      -- TODO 1265 (wave 94 bundle D, ARCHITECTURE 6.2.4): a reminder's snooze. The time (epoch ms) it notifies again, or NULL.
      -- Independent of the repeat's anchor (anchor_at). Existing rows keep their kind ('prompt' / 'plugin' / ...) and get NULL.
      ALTER TABLE scheduled_jobs ADD COLUMN snooze_at INTEGER;
    `,
    skipIfColumn: { table: 'scheduled_jobs', column: 'snooze_at' }
  },
  {
    version: 45,
    name: 'roles',
    up: `
      -- TODO 972 (wave 96 bundle A, ARCHITECTURE 4.3.4): a role (shown to the user as a "Teammate") is the parent of conversations.
      -- One row = the things that stay the same across its conversations: name, working folder (NULL = a scratch area per conversation),
      -- standing instructions (the user's own text, kept as written like a scheduled prompt) and the default Model / Thinking.
      -- Later items add their own columns (allowed connectors, the permission table 983, the hand-over memory 984).
      -- No role row is made for existing conversations (owner decision 2026-11-21: no default role).
      CREATE TABLE IF NOT EXISTS roles (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        cwd          TEXT,
        instructions TEXT NOT NULL DEFAULT '',
        model_id     TEXT,
        thinking     TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
    `
  },
  {
    version: 46,
    name: 'thread-role',
    up: `
      -- TODO 972: the role a conversation belongs to (roles.id), or NULL. Existing rows stay NULL (they are listed as before).
      ALTER TABLE threads ADD COLUMN role_id TEXT;
    `,
    skipIfColumn: { table: 'threads', column: 'role_id' }
  },
  {
    version: 47,
    name: 'role-approval-strict',
    up: `
      -- TODO 983 stage 4 (wave 97 bundle A, ARCHITECTURE 4.2.5): a Teammate's strict-mode toggle (default OFF, owner decision 2026-11-21).
      -- When 1, every conversation started under the role (by hand or by a scheduled job) starts in strict mode; a job's own
      -- approvalStrict is combined with OR (the closing side). Existing roles get 0 (unchanged behaviour).
      ALTER TABLE roles ADD COLUMN approval_strict INTEGER NOT NULL DEFAULT 0;
    `,
    skipIfColumn: { table: 'roles', column: 'approval_strict' }
  },
  {
    version: 48,
    name: 'thread-started-unattended',
    up: `
      -- TODO 1289 (code-review, wave 97 fix Y, ARCHITECTURE 7.6.9): 1 = a bundle conversation started from an unattended turn (a scheduled
      -- job's, or another such bundle's). Its turns that a person did not start count as unattended across a restart. Written only by
      -- main's ThreadStore. Existing rows get 0 (before this the mark was in memory only and is gone anyway).
      ALTER TABLE threads ADD COLUMN started_unattended INTEGER NOT NULL DEFAULT 0;
    `,
    skipIfColumn: { table: 'threads', column: 'started_unattended' }
  },
  {
    version: 49,
    name: 'thread-drill',
    up: `
      -- TODO 982 (ARCHITECTURE 4.2.5 "drill"): 1 = a drill conversation that has not been sent yet, 2 = its one run was sent. 0 = not a drill.
      -- Written only by main's ThreadStore; never cleared (the gateway stops outward operations while it is non-zero). Existing rows get 0.
      ALTER TABLE threads ADD COLUMN drill INTEGER NOT NULL DEFAULT 0;
      -- The operations a drill stopped (one row each), for the list shown after the run and "allow from now on" (TODO 1292 item 2).
      -- Only the smallest description is kept - a path, a masked command or URL, a recipient, a masked subject, the body's length - never the
      -- body (constraints 9 / 10). grant_candidates is the JSON of the rows "allow from now on" would add (the same values role_grants keeps),
      -- decided by main when the op was stopped; grant_refusal is why there is none.
      CREATE TABLE IF NOT EXISTS drill_ops (
        id               TEXT PRIMARY KEY,
        thread_id        TEXT NOT NULL,
        created_at       INTEGER NOT NULL,
        tool_use_id      TEXT,
        tool_name        TEXT NOT NULL,
        target_kind      TEXT,
        target           TEXT,
        subject          TEXT,
        size             INTEGER,
        grant_candidates TEXT,
        grant_refusal    TEXT,
        granted_at       INTEGER
      );
      CREATE INDEX IF NOT EXISTS drill_ops_thread ON drill_ops (thread_id, created_at);
    `,
    skipIfColumn: { table: 'threads', column: 'drill' }
  },
  {
    version: 50,
    name: 'plugin-documents-uri-index',
    up: `
      -- TODO 1284 item 2: PluginDocumentStore.readByUri looks a row up by uri inside one owner's namespace. The table's only index is its
      -- (source, source_id) primary key, so that lookup scanned every row. uri is NOT NULL but not unique (two documents may share one), so this
      -- is a plain index; source is the second column so the owner test is answered from the index alone. IF NOT EXISTS lets it be re-applied.
      CREATE INDEX IF NOT EXISTS plugin_documents_uri ON plugin_documents (uri, source);
    `
  },
  {
    version: 51,
    name: 'thread-import-pending',
    up: `
      -- TODO 1318 (review X, ARCHITECTURE 8.6): the id of the import run that is adding this thread, until the file's second tag check
      -- passes; NULL for every other thread. Such a row is also written with deleted_at set, so every read of live threads misses it, and
      -- this column keeps it out of the deleted list and its restore. The run publishes its rows in one statement (both columns back to
      -- NULL); a failed run removes them, and what is left (a failed cleanup, a crash, a quit) is removed at the next launch.
      -- Written only by main's ThreadStore. Existing rows get NULL (no table rewrite).
      ALTER TABLE threads ADD COLUMN import_pending TEXT;
    `,
    skipIfColumn: { table: 'threads', column: 'import_pending' }
  }
]

/**
 * Functions callable from a migration's SQL. SQLite's lower() folds only ASCII,
 * so path folding (NFC + toLowerCase) uses the JS implementation as it is (migration 15).
 */
function registerMigrationFunctions(db: Database): void {
  db.function('aios_fold_path', { deterministic: true }, (value: unknown) =>
    typeof value === 'string' ? foldPath(value) : null
  )
  // TODO 722: used by migration 26's UPDATE to fill the host column of the existing web_history / web_favorites.
  // TODO 838: migration 29. The same truncation as at save time (common/clip-json.ts). Broken JSON is left alone.
  db.function('aios_clip_permission_payload', { deterministic: true }, (value: unknown) => {
    if (typeof value !== 'string') return value
    try {
      const parsed: unknown = JSON.parse(value)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !('input' in parsed)) return value
      const record = parsed as Record<string, unknown>
      return JSON.stringify({ ...record, input: clipPermissionInput(record['input'] as JsonValue) })
    } catch {
      return value
    }
  })
  db.function('aios_web_host', { deterministic: true }, (value: unknown) =>
    typeof value === 'string' ? webHostOf(value) : null
  )
}

/**
 * The latest migration number this version of aios knows. The downgrade safety net
 * (TODO 103) uses it to decide "the DB is newer".
 */
export const LATEST_KNOWN_MIGRATION = MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0
)

/**
 * The downgrade safety net (TODO 103, wave 11 bundle G). In a migration scheme that only moves forward with the single `user_version`,
 * **opening a DB made by a newer version with an older version risks the old version's SQL writing columns and tables
 * that only the new version knows about, without knowing them** (the section after Phase 3: it has the same root as the known pitfall
 * that when numbers collide one side is silently skipped - "`user_version` points beyond what this version knows").
 * It carries `dbVersion` (the actual `user_version`) and `knownVersion` (the latest migration number
 * this version knows). **The caller (both main and the index process) must catch this exception before writing and exit without opening** -
 * degrading to memory-only looks safe because the DB is not overwritten, but to the user it only looks like "the scan started over",
 * while in fact the newer version's data is left untouched, which is confusing.
 */
export class DatabaseTooNewError extends Error {
  constructor(
    readonly dbVersion: number,
    readonly knownVersion: number
  ) {
    super(`database user_version ${dbVersion} is newer than the ${knownVersion} this build knows`)
    this.name = 'DatabaseTooNewError'
  }
}

export function runMigrations(db: Database): number {
  const current = db.pragma('user_version', { simple: true }) as number
  if (current > LATEST_KNOWN_MIGRATION) throw new DatabaseTooNewError(current, LATEST_KNOWN_MIGRATION)
  let applied = current
  if (MIGRATIONS.some((migration) => migration.version > applied)) registerMigrationFunctions(db)

  for (const migration of MIGRATIONS) {
    if (migration.version <= applied) continue
    const started = Date.now()
    db.exec('BEGIN')
    try {
      const skip = migration.skipIfColumn
      if (skip === undefined || !hasColumn(db, skip.table, skip.column)) db.exec(migration.up)
      // pragma uses string interpolation, but version comes from the constant table above, not from external input.
      db.pragma(`user_version = ${migration.version}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    applied = migration.version
    log.info('db.migrated', {
      version: migration.version,
      name: migration.name,
      ms: Date.now() - started
    })
  }

  return applied
}
