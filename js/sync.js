// ============================================================
//  sync.js  --  window-to-window messaging
// ------------------------------------------------------------
//  The ONLY module that knows how the GM window and the Player
//  window talk to each other. Today that is the BroadcastChannel
//  API (both windows are tabs in the same browser on the same
//  machine, sharing one origin). If we later move the Player to a
//  separate device, only this file changes: swap BroadcastChannel
//  for a websocket and keep the same createSync() shape.
//
//  Usage:
//    const sync = createSync((message) => { ...react... });
//    sync.post({ type: 'state', state });
// ============================================================

const CHANNEL_NAME = 'aldermere-gm';

export function createSync(onMessage) {
  if (typeof BroadcastChannel === 'undefined') {
    // Very old browser, or a context without BroadcastChannel. The app
    // still runs as a single window; it just cannot sync to a second one.
    console.warn('BroadcastChannel is not available; window-to-window sync is off.');
    return { post() {}, close() {} };
  }

  const channel = new BroadcastChannel(CHANNEL_NAME);

  channel.onmessage = (event) => {
    try {
      onMessage(event.data);
    } catch (err) {
      console.error('sync message handler failed', err);
    }
  };

  return {
    post(message) {
      channel.postMessage(message);
    },
    close() {
      channel.close();
    }
  };
}
