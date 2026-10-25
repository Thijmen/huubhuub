/**
 * The page an invite link opens on a phone: a button that hands the code to the app, and a download link for
 * people who don't have it yet. The code stays in the URL fragment and is read by the page's script.
 */
export function invitePage(downloadUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>HuubHuub</title>
<style>
  :root { color-scheme: light dark; --bg: #fff8ef; --fg: #2b2118; --muted: #7a6a5c; --primary: #ff7a45; --card: #ffffff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1d1712; --fg: #f7ede2; --muted: #b8a797; --card: #2a221b; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
    font: 17px/1.5 ui-rounded, "SF Pro Rounded", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding: 24px; }
  main { width: 100%; max-width: 380px; background: var(--card); border-radius: 28px; padding: 32px 24px; text-align: center;
    box-shadow: 0 10px 40px rgba(0,0,0,.08); }
  h1 { font-size: 28px; margin: 8px 0 4px; }
  p { color: var(--muted); margin: 8px 0 24px; }
  .button { display: block; padding: 16px; border-radius: 18px; background: var(--primary); color: #fff; font-weight: 700;
    text-decoration: none; font-size: 18px; }
  .secondary { display: block; margin-top: 16px; color: var(--muted); }
  .hidden { display: none; }
</style>
</head>
<body>
<main>
  <div style="font-size:56px">👋</div>
  <h1>HuubHuub</h1>
  <div id="ok">
    <p data-en="You've been invited. Tap the button to sign in on this phone." data-nl="Je bent uitgenodigd. Tik op de knop om op deze telefoon in te loggen."></p>
    <a id="open" class="button" href="#" data-en="Open in the app" data-nl="Open in de app"></a>
    <a class="secondary" href="${escapeAttr(downloadUrl)}" data-en="Don't have the app yet? Download it" data-nl="Heb je de app nog niet? Download hem hier"></a>
  </div>
  <div id="bad" class="hidden">
    <p data-en="This invite link is incomplete. Ask for a new one." data-nl="Deze uitnodiging is niet compleet. Vraag om een nieuwe."></p>
  </div>
</main>
<script>
  var nl = (navigator.language || "").toLowerCase().indexOf("nl") === 0;
  document.querySelectorAll("[data-en]").forEach(function (el) { el.textContent = el.getAttribute(nl ? "data-nl" : "data-en"); });
  var code = location.hash.slice(1);
  if (!code) {
    document.getElementById("ok").className = "hidden";
    document.getElementById("bad").className = "";
  } else {
    var server = location.origin + location.pathname.replace(/\\/pair\\/?$/, "");
    document.getElementById("open").href = "huubhuub://pair?server=" + encodeURIComponent(server) + "&code=" + encodeURIComponent(code);
  }
</script>
</body>
</html>`
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
}
