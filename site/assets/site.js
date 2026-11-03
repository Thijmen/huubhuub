// Small progressive enhancements. Every page works without this file.

const topbar = document.querySelector(".topbar")
const onScroll = () => topbar?.classList.toggle("scrolled", window.scrollY > 8)
addEventListener("scroll", onScroll, { passive: true })
onScroll()

// Mobile menus
for (const btn of document.querySelectorAll("[data-toggle]")) {
  btn.addEventListener("click", () => {
    const target = document.querySelector(btn.dataset.toggle)
    const open = target?.classList.toggle("open")
    btn.setAttribute("aria-expanded", String(Boolean(open)))
  })
}

// Tour tabs
const tabs = [...document.querySelectorAll('[role="tab"]')]
for (const tab of tabs) {
  tab.addEventListener("click", () => {
    for (const t of tabs) {
      const selected = t === tab
      t.setAttribute("aria-selected", String(selected))
      document.getElementById(t.getAttribute("aria-controls")).hidden = !selected
    }
  })
}

// Admin screenshot picker
const shot = document.querySelector("[data-shot]")
const caption = document.querySelector(".shot-caption")
const url = document.querySelector(".browser .bar span")
for (const btn of document.querySelectorAll(".shot-picker button")) {
  btn.addEventListener("click", () => {
    for (const b of document.querySelectorAll(".shot-picker button")) b.setAttribute("aria-pressed", String(b === btn))
    shot.src = btn.dataset.src
    shot.alt = btn.dataset.alt
    caption.innerHTML = btn.dataset.caption
    url.textContent = btn.dataset.url
  })
}

// Copy buttons on code blocks
for (const pre of document.querySelectorAll(".prose pre")) {
  const btn = document.createElement("button")
  btn.className = "copy"
  btn.type = "button"
  btn.textContent = "Copy"
  btn.addEventListener("click", async () => {
    await navigator.clipboard.writeText(pre.querySelector("code")?.innerText ?? pre.innerText)
    btn.textContent = "Copied"
    setTimeout(() => (btn.textContent = "Copy"), 1400)
  })
  pre.append(btn)
}

// Highlight the section in "On this page" that's on screen
const tocLinks = [...document.querySelectorAll(".toc a")]
if (tocLinks.length && "IntersectionObserver" in window) {
  const byId = new Map(tocLinks.map((a) => [decodeURIComponent(a.hash.slice(1)), a]))
  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        for (const a of tocLinks) a.classList.toggle("active", a === byId.get(e.target.id))
      }
    },
    { rootMargin: "-80px 0px -70% 0px" },
  )
  for (const id of byId.keys()) {
    const el = document.getElementById(id)
    if (el) observer.observe(el)
  }
}
