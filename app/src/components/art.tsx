import Svg, { Circle, Ellipse, Path, Rect } from "react-native-svg"

/** Huub: a speech bubble with a face and a cowlick. */
export function HuubAvatar({ size = 32 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" accessibilityLabel="Huub">
      <Path d="M31 11.5c-.5-4 2.2-7 6.6-7.2" fill="none" stroke="#E85D04" strokeWidth={3.6} strokeLinecap="round" />
      <Path d="M18.5 51.5C16.5 56 13 59.5 8.5 61c6.5 1 13-.5 17.5-3.5z" fill="#E85D04" />
      <Circle cx={33} cy={35} r={24} fill="#E85D04" />
      <Ellipse cx={25.5} cy={33} rx={3.3} ry={4.4} fill="#1D2233" />
      <Ellipse cx={40.5} cy={33} rx={3.3} ry={4.4} fill="#1D2233" />
      <Circle cx={26.6} cy={31.4} r={1.1} fill="#fff" />
      <Circle cx={41.6} cy={31.4} r={1.1} fill="#fff" />
      <Circle cx={19.5} cy={41} r={3.4} fill="#FFB27A" opacity={0.85} />
      <Circle cx={46.5} cy={41} r={3.4} fill="#FFB27A" opacity={0.85} />
      <Path d="M27 42.5q6 5.2 12 0" fill="none" stroke="#1D2233" strokeWidth={3} strokeLinecap="round" />
    </Svg>
  )
}

export type IconName = "back" | "search" | "new" | "send" | "stop" | "settings" | "link" | "check"

/** Line icons from the design proposal, drawn in `color`. */
export function Icon({ name, size = 24, color }: { name: IconName; size?: number; color: string }) {
  const stroke = { fill: "none", stroke: color, strokeWidth: 2.1, strokeLinecap: "round" as const, strokeLinejoin: "round" as const }
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === "back" && <Path d="M19 12H5M11.5 18.5 5 12l6.5-6.5" {...stroke} strokeWidth={2.2} />}
      {name === "search" && (
        <>
          <Circle cx={11} cy={11} r={6.5} {...stroke} />
          <Path d="m20 20-4-4" {...stroke} />
        </>
      )}
      {name === "new" && (
        <>
          <Path d="M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5h-9L5 21.5V6A1.5 1.5 0 0 1 5 4.5z" {...stroke} />
          <Path d="M12 8v6M9 11h6" {...stroke} />
        </>
      )}
      {name === "send" && <Path d="M12 19V5.5M5.5 11.5 12 5l6.5 6.5" {...stroke} strokeWidth={2.5} />}
      {name === "stop" && <Rect x={6} y={6} width={12} height={12} rx={3} fill={color} />}
      {name === "settings" && (
        <>
          <Path d="M4 7h9M19 7h1M4 17h3M13 17h7" {...stroke} />
          <Circle cx={16} cy={7} r={2.6} {...stroke} />
          <Circle cx={10} cy={17} r={2.6} {...stroke} />
        </>
      )}
      {name === "link" && (
        <Path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" {...stroke} />
      )}
      {name === "check" && <Path d="M5 12.5 10 17.5 19 7" {...stroke} strokeWidth={2.5} />}
    </Svg>
  )
}
