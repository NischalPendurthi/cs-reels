// Runs at document start inside YouTube frames (the embedded player).
// Same idea as uBlock Origin's json-prune: strip ad slots from the player
// data so the player never schedules pre-roll / mid-roll ads.
(function () {
  if (window.__csReelsAdblock) return;
  window.__csReelsAdblock = true;
  var KEYS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams', 'adBreakParams'];
  var pruned = 0;
  function prune(o) {
    try {
      if (o && typeof o === 'object') {
        for (var i = 0; i < KEYS.length; i++) if (KEYS[i] in o) { delete o[KEYS[i]]; pruned++; }
        if (o.playerResponse && typeof o.playerResponse === 'object') prune(o.playerResponse);
        if (o.response && typeof o.response === 'object') prune(o.response);
      }
    } catch (e) {}
    return o;
  }
  window.__csReelsAdblockCount = function () { return pruned; };
  var jp = JSON.parse;
  JSON.parse = function () { return prune(jp.apply(this, arguments)); };
  try {
    var rj = Response.prototype.json;
    Response.prototype.json = function () { return rj.apply(this, arguments).then(prune); };
  } catch (e) {}
  ['ytInitialPlayerResponse', 'ytInitialData'].forEach(function (name) {
    var v;
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        get: function () { return v; },
        set: function (x) { v = prune(x); }
      });
    } catch (e) {}
  });
})();
