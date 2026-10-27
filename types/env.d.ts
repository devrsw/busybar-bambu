/** BUSY Bar address the app connects to, set at build time with `busy-cli build --addr`; `localhost` by default, the device the app runs on. */
declare const __BUSY_ADDR__: string

/** A .anim file is a binary device asset; Vite returns its URL. */
declare module '*.anim' {
  const src: string
  export default src
}

/** A device input event. */
type BusyInputEvent =
  | {
      readonly key: 'encoder'
      readonly action: 'clockwise' | 'counterclockwise'
      readonly delta: 1 | -1
    }
  | {
      readonly key: 'ok' | 'start' | 'back'
      readonly action: 'press' | 'release' | 'short' | 'long' | 'repeat'
    }

/** Detaches the handler. The runtime may stop the app once nothing else keeps it alive. */
type BusyUnbind = () => void

/**
 * Subscribes to device input. Throws a TypeError on an unknown type, or when a handler is already attached.
 * @param type - Only 'input' is accepted.
 */
declare function listen(
  type: 'input',
  handler: (event: BusyInputEvent) => void,
): BusyUnbind
