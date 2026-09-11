/**
 * The script the bot runs inside Meet's page, before Meet's own.
 *
 * IT ONLY FORWARDS. It hooks the three things worth having - the caption
 * channels, the participant channel, and the participant list Meet fetches -
 * and hands their raw bytes to Wouice through a binding. Deciding what the
 * bytes mean happens in Node (`meet-protocol.ts`), where it can be tested; a
 * script inside somebody else's page is the worst place to be clever.
 *
 * WHY BEFORE MEET'S SCRIPTS. Meet opens its data channels itself, through the
 * browser's `RTCPeerConnection`. The hook has to be on that constructor before
 * Meet takes a reference to it, which is what `addInitScript` guarantees. The
 * approach is Attendee's (Elastic License 2.0); this code is our own.
 *
 * A HEARTBEAT, because a dead page and a quiet meeting look the same from
 * outside. Wouice notices when the heartbeats stop.
 *
 * A string, not a function: what runs is exactly this text, whatever a bundler
 * does to the rest of the app.
 */

/** The name the page calls to reach Wouice. */
export const PAGE_BINDING = '__wouiceMeet'

/** What the page sends. `dc` carries a data-channel message as base64, or text. */
export type PageMessage =
  | { type: 'dc'; label: string; b64?: string; text?: string }
  | { type: 'sync'; text: string }
  | { type: 'channel'; label: string }
  | { type: 'heartbeat' }
  | { type: 'error'; message: string }

export const MEET_PAYLOAD = `(function (window) {
  if (window.__wouiceInstalled) return;
  window.__wouiceInstalled = true;

  var send = function (message) {
    try { window[${JSON.stringify(PAGE_BINDING)}](JSON.stringify(message)); } catch (e) {}
  };

  var toBase64 = function (data) {
    var bytes = null;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (!bytes) return null;
    var binary = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, Array.prototype.slice.call(bytes.subarray(i, i + 0x8000)));
    }
    return window.btoa(binary);
  };

  var WATCHED = { captions: true, captions_v2: true, collections: true };
  var watch = function (channel) {
    if (!channel || channel.__wouiceWatched) return;
    channel.__wouiceWatched = true;
    // Every label, watched or not: the first sign Meet has renamed a channel.
    send({ type: 'channel', label: String(channel.label) });
    if (!WATCHED[channel.label]) return;
    channel.addEventListener('message', function (event) {
      var data = event.data;
      if (typeof data === 'string') { send({ type: 'dc', label: channel.label, text: data }); return; }
      if (data && typeof data.arrayBuffer === 'function' && !(data instanceof ArrayBuffer)) {
        data.arrayBuffer().then(function (buffer) {
          send({ type: 'dc', label: channel.label, b64: toBase64(buffer) });
        });
        return;
      }
      var b64 = toBase64(data);
      if (b64) send({ type: 'dc', label: channel.label, b64: b64 });
    });
  };

  var Native = window.RTCPeerConnection;
  if (Native) {
    // Channels Meet's page opens itself: captions.
    var create = Native.prototype.createDataChannel;
    Native.prototype.createDataChannel = function () {
      var channel = create.apply(this, arguments);
      try { watch(channel); } catch (e) { send({ type: 'error', message: String(e) }); }
      return channel;
    };
    // Channels Meet's server opens: participants.
    var Hooked = function () {
      var connection = new (Function.prototype.bind.apply(Native, [null].concat(Array.prototype.slice.call(arguments))))();
      connection.addEventListener('datachannel', function (event) {
        try { watch(event.channel); } catch (e) { send({ type: 'error', message: String(e) }); }
      });
      return connection;
    };
    Hooked.prototype = Native.prototype;
    Object.setPrototypeOf(Hooked, Native);
    window.RTCPeerConnection = Hooked;
  }

  // The full participant list, which Meet fetches for itself now and then.
  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var result = nativeFetch.apply(this, arguments);
      if (url.indexOf('SyncMeetingSpaceCollections') !== -1) {
        result
          .then(function (response) { return response.clone().text(); })
          .then(function (text) { send({ type: 'sync', text: text }); })
          .catch(function () {});
      }
      return result;
    };
  }

  window.setInterval(function () { send({ type: 'heartbeat' }); }, 5000);
})(window);`
