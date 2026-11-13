const input = document.getElementById("url");
getUrl().then((u) => (input.value = u));
document.getElementById("save").onclick = () => {
  let u = input.value.trim();
  try { const x = new URL(u); if (!/^https?:$/.test(x.protocol)) throw 0; } catch { document.getElementById("ok").textContent = "That is not a web address."; return; }
  if (!u.endsWith("/")) u += "/";
  chrome.storage.sync.set({ url: u }, () => (document.getElementById("ok").textContent = "Saved. Reopen the side panel."));
};
