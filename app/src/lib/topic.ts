/**
 * What a conversation's tile shows: an emoji the title starts with, or one that fits a common topic, or else
 * the title's first letter. The tint is picked from the conversation ID, so it never changes.
 */
export interface Topic {
  emoji: string | null
  letter: string
  /** The title without its leading emoji. */
  title: string
  tint: number
}

const LEADING_EMOJI = /^\s*((?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:️|‍(?:\p{Extended_Pictographic}|️)|\p{Emoji_Modifier}|\p{Regional_Indicator})*)\s*/u

/** Word starts, in Dutch and English, and the emoji that goes with them. First match wins. */
const TOPICS: [string, RegExp][] = [
  ["🛒", /^(boodschap|grocer|shopping|supermarkt)/],
  ["🦷", /^(tandarts|dentist)/],
  ["🩺", /^(dokter|huisarts|doctor|gezondheid|health|ziek|medicijn|medicine|apotheek|pharmacy)/],
  ["⏰", /^(herinner|remind|wekker|alarm)/],
  ["🎂", /^(verjaardag|birthday|jarig)/],
  ["🎁", /^(cadeau|gift|present|kado)/],
  ["✈️", /^(vakantie|holiday|vacation|vlucht|flight|reis|travel|trip)/],
  ["🌊", /^(strand|beach|zee|texel|ameland|terschelling|vlieland|schiermonnikoog)/],
  ["🧳", /^(weekend|weekendje|logeren)/],
  ["🍝", /^(pasta|spaghetti|lasagne)/],
  ["🥗", /^(salade|salad|spinazie|feta|groente|vegetar|vegan)/],
  ["🍽️", /^(eten|recept|recipe|koken|cook|diner|dinner|lunch|ontbijt|breakfast|maaltijd|meal|avondeten)/],
  ["☕", /^(koffie|coffee)/],
  ["🍷", /^(wijn|wine|borrel)/],
  ["🪴", /^(plant|monstera|kamerplant|houseplant)/],
  ["🌷", /^(tuin|garden|bloem|flower)/],
  ["✍️", /^(sollicitatie|brief|letter|essay|cv|motivatie|schrijf|writ|tekst)/],
  ["✉️", /^(mail|e-mail|email|bericht|message|whatsapp|appje)/],
  ["💶", /^(geld|money|budget|kosten|belasting|tax|factuur|invoice|bank|sparen|saving|hypotheek|mortgage|verzekering|insurance)/],
  ["🎒", /^(school|huiswerk|homework|studie|study|tentamen|exam)/],
  ["🏋️", /^(gym|fitness|workout|sportschool)/],
  ["🏠", /^(huis|house|home|verhuis|moving|woning|huur|rent|verbouw|renovat)/],
  ["🚗", /^(auto|autos|car|cars|apk|garage|parkeren|parking)$/],
  ["🚲", /^(fiets|bike|bicycle)/],
  ["🚆", /^(trein|train|ns$|ov$|ov-)/],
  ["🌦️", /^(weer|weather|regen|rain)/],
  ["🎵", /^(muziek|music|playlist|liedje|song|concert)/],
  ["🎬", /^(film|movie|serie|series|netflix)/],
  ["📚", /^(boek|book|lezen|reading|bibliotheek|library)/],
  ["⚽", /^(voetbal|football|soccer|sport)/],
  ["🏃", /^(hardlopen|running|marathon)/],
  ["💼", /^(werk|work|job|baan|meeting|vergader|sollicit|carri)/],
  ["💻", /^(code|coding|computer|laptop|programm|script|bug|server|website|app\b|software|python|javascript)/],
  ["🐶", /^(hond|dog|puppy)/],
  ["🐱", /^(kat$|katten|cat$|cats$|kitten|poes)/],
  ["👶", /^(baby|zwanger|pregnan)/],
  ["🎉", /^(feest|party|bruiloft|wedding)/],
  ["📅", /^(agenda|planning|calendar|schedule|afspraak|appointment)/],
  ["🧹", /^(schoonma|clean|opruim)/],
  ["🗺️", /^(route|kaart|map\b|wandel|hike|hiking)/],
  ["🌐", /^(vertaal|translat)/],
  ["💡", /^(idee|idea|brainstorm)/],
]

export function topicOf(title: string | null, id: string): Topic {
  const raw = (title ?? "").trim()
  const lead = raw.match(LEADING_EMOJI)
  const rest = lead ? raw.slice(lead[0].length) : raw
  const words = rest
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}-]+/u)
    .filter(Boolean)
  const found = lead ? lead[1]! : (TOPICS.find(([, re]) => words.some((w) => re.test(w)))?.[0] ?? null)
  const letter = (rest.match(/\p{L}|\p{N}/u)?.[0] ?? "H").toLocaleUpperCase()
  return { emoji: found, letter, title: rest, tint: hash(id) }
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}
