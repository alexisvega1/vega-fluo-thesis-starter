// Where Vega Fluo lives. The tailnet address works from this Mac, lostdoc-linux and the phone;
// on the Mac itself http://127.0.0.1:4317 works too. Change it in the extension's options.
const DEFAULT_URL = "http://127.0.0.1:4317/";
const getUrl = () => new Promise((ok) => chrome.storage.sync.get({ url: DEFAULT_URL }, (v) => ok(v.url || DEFAULT_URL)));
