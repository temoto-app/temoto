/**
 * The renderer's entry (TODO 807, ARCHITECTURE 3.1 "launch order"). Only the boot steps run here (`boot.ts`); the app is a separate
 * chunk, imported once main has the DB open and every handler registered.
 */
import './styles.css'
import { startBoot } from './boot.js'

void startBoot(() => import('./app-main.js'))
