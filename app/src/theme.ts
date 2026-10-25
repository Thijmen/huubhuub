import { useColorScheme } from "react-native"

/** "Zondag": Dutch orange and Delft blue on cream. See docs/app/design-proposal.html. */
export const light = {
  bg: "#FFF8F0",
  surface: "#FFFFFF",
  surfaceAlt: "#FBEEDF",
  text: "#1D2233",
  textMuted: "#6B6672",
  border: "#F0E3D3",
  borderStrong: "#E6D5C2",
  primary: "#E85D04",
  onPrimary: "#FFFFFF",
  primaryText: "#B8460A",
  primarySoft: "#FFE9D8",
  accent: "#2D4BA0",
  accentSoft: "#E8EDFA",
  userBubble: "#FFE2CC",
  userBubbleText: "#1D2233",
  huubBubble: "#FFFFFF",
  huubBubbleBorder: "#F2E6D8",
  codeBg: "#1D2233",
  codeText: "#F5EDE4",
  inlineCodeBg: "#EAEFFB",
  inlineCodeText: "#2D4BA0",
  questionBorder: "#FFCDA8",
  success: "#2F8F5B",
  danger: "#C93A2B",
}

export type Palette = typeof light

export const dark: Palette = {
  bg: "#17130F",
  surface: "#221D18",
  surfaceAlt: "#2C251F",
  text: "#F5EDE4",
  textMuted: "#A99E92",
  border: "#342C25",
  borderStrong: "#463C33",
  primary: "#FF7A2E",
  onPrimary: "#1D1007",
  primaryText: "#FF9A5C",
  primarySoft: "#3A2414",
  accent: "#9DB2F5",
  accentSoft: "#232A42",
  userBubble: "#5C2E12",
  userBubbleText: "#FFEBDD",
  huubBubble: "#221D18",
  huubBubbleBorder: "#30281F",
  codeBg: "#0E0B09",
  codeText: "#F5EDE4",
  inlineCodeBg: "#262C42",
  inlineCodeText: "#B5C4F7",
  questionBorder: "#6A3A18",
  success: "#5CC98A",
  danger: "#FF6B5E",
}

export const radius = { xs: 6, sm: 10, md: 14, lg: 20, xl: 28, pill: 999, bubble: 20, bubbleTail: 6, fab: 22 } as const
export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32, huge: 48 } as const

export const font = {
  rounded: "Nunito_800ExtraBold",
  roundedSemi: "Nunito_700Bold",
  mono: "monospace",
  size: { caption: 12, small: 14, label: 15, body: 16, heading: 17.5, title: 22, display: 28, code: 13.5 },
  lineHeight: { caption: 16, small: 19, label: 20, body: 24, heading: 24, title: 26, display: 34, code: 19 },
} as const

export function useTheme(): { c: Palette; dark: boolean } {
  const scheme = useColorScheme()
  return scheme === "dark" ? { c: dark, dark: true } : { c: light, dark: false }
}
