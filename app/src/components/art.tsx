import { useEffect } from "react"
import { Text, View, type ViewStyle } from "react-native"
import Animated, { Easing, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from "react-native-reanimated"
import Svg, { Circle, Ellipse, Path, Rect } from "react-native-svg"
import { font, radius, useTheme } from "@/theme"

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

/** Huub in a soft, slightly tilted square: the big friendly mark on empty and welcome screens. */
export function Halo({ size = 104 }: { size?: number }) {
  const { c } = useTheme()
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.35, borderCurve: "continuous", backgroundColor: c.primarySoft, alignItems: "center", justifyContent: "center", transform: [{ rotate: "-5deg" }] }}>
      <View style={{ transform: [{ rotate: "5deg" }] }}>
        <HuubAvatar size={size * 0.75} />
      </View>
    </View>
  )
}

/** Huub in a rounded square, for headers. */
export function AvatarTile({ size = 44 }: { size?: number }) {
  const { c } = useTheme()
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.36, borderCurve: "continuous", backgroundColor: c.primarySoft, alignItems: "center", justifyContent: "center" }}>
      <HuubAvatar size={size * 0.77} />
    </View>
  )
}

/** A conversation's tile: its emoji (or first letter) on a soft tint. */
export function Tile({ emoji, letter, tint, size = 44 }: { emoji: string | null; letter: string; tint: number; size?: number }) {
  const { c } = useTheme()
  return (
    <View style={{ width: size, height: size, borderRadius: radius.tile, borderCurve: "continuous", backgroundColor: c.tints[tint % c.tints.length], alignItems: "center", justifyContent: "center" }}>
      {emoji ? (
        <Text style={{ fontSize: size * 0.48 }}>{emoji}</Text>
      ) : (
        <Text style={{ fontFamily: font.rounded, fontSize: size * 0.45, color: c.primaryText }}>{letter}</Text>
      )}
    </View>
  )
}

/** A small ring that spins: Huub is busy. */
export function Spinner({ size = 13, color, width = 2 }: { size?: number; color?: string; width?: number }) {
  const { c } = useTheme()
  const turn = useSharedValue(0)
  useEffect(() => {
    turn.value = withRepeat(withTiming(1, { duration: 800, easing: Easing.linear }), -1)
  }, [turn])
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 360}deg` }] }))
  const tone = color ?? c.primary
  return <Animated.View style={[{ width: size, height: size, borderRadius: size / 2, borderWidth: width, borderColor: tone, borderRightColor: "transparent" }, style]} />
}

/** Three dots that bob in turn, like someone typing. */
export function TypingDots({ size = 5, color }: { size?: number; color?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: size * 0.6 }}>
      {[0, 1, 2].map((i) => (
        <Dot key={i} delay={i * 150} size={size} color={color} />
      ))}
    </View>
  )
}

function Dot({ delay, size, color }: { delay: number; size: number; color?: string }) {
  const { c } = useTheme()
  const t = useSharedValue(0)
  useEffect(() => {
    t.value = withDelay(delay, withRepeat(withSequence(withTiming(1, { duration: 360 }), withTiming(0, { duration: 360 }), withTiming(0, { duration: 480 })), -1))
  }, [delay, t])
  const style = useAnimatedStyle(() => ({ opacity: 0.45 + t.value * 0.55, transform: [{ translateY: -3 * t.value }] }))
  return <Animated.View style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: color ?? c.primaryText }, style]} />
}

export type IconName =
  | "back"
  | "search"
  | "new"
  | "send"
  | "stop"
  | "settings"
  | "link"
  | "check"
  | "camera"
  | "mic"
  | "close"
  | "pin"
  | "archive"
  | "more"
  | "chevron"
  | "chevronDown"
  | "sparkle"
  | "copy"
  | "lock"
  | "torch"
  | "play"

/** Line icons from the design proposal, drawn in `color`. */
export function Icon({ name, size = 24, color, style }: { name: IconName; size?: number; color: string; style?: ViewStyle }) {
  const stroke = { fill: "none", stroke: color, strokeWidth: 2.1, strokeLinecap: "round" as const, strokeLinejoin: "round" as const }
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" style={style}>
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
      {name === "stop" && <Rect x={5} y={5} width={14} height={14} rx={3} fill={color} />}
      {name === "settings" && (
        <>
          <Path d="M4 7h9M19 7h1M4 17h3M13 17h7" {...stroke} />
          <Circle cx={16} cy={7} r={2.6} {...stroke} />
          <Circle cx={10} cy={17} r={2.6} {...stroke} />
        </>
      )}
      {name === "link" && <Path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" {...stroke} />}
      {name === "check" && <Path d="M5 12.5 10 17.5 19 7" {...stroke} strokeWidth={2.5} />}
      {name === "camera" && (
        <>
          <Path d="M4.5 7.5h3L9.2 5h5.6l1.7 2.5h3A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5V9a1.5 1.5 0 0 1 1.5-1.5z" {...stroke} strokeWidth={2} />
          <Circle cx={12} cy={13.3} r={3.4} {...stroke} strokeWidth={2} />
        </>
      )}
      {name === "mic" && (
        <>
          <Rect x={9} y={3} width={6} height={11.5} rx={3} {...stroke} />
          <Path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" {...stroke} />
        </>
      )}
      {name === "close" && <Path d="M6 6l12 12M18 6 6 18" {...stroke} strokeWidth={2.4} />}
      {name === "pin" && <Path d="M12 16.5V22M8.5 3h7l-1 5.5 3.5 3.5v2.5H6V12l3.5-3.5z" fill={color} stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />}
      {name === "archive" && (
        <>
          <Rect x={3.5} y={4} width={17} height={4.5} rx={1.2} {...stroke} />
          <Path d="M5 8.5v10A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-10M10 12.5h4" {...stroke} />
        </>
      )}
      {name === "more" && (
        <>
          <Circle cx={12} cy={5.5} r={1.8} fill={color} />
          <Circle cx={12} cy={12} r={1.8} fill={color} />
          <Circle cx={12} cy={18.5} r={1.8} fill={color} />
        </>
      )}
      {name === "chevron" && <Path d="m9 5 7 7-7 7" {...stroke} strokeWidth={2.2} />}
      {name === "chevronDown" && <Path d="m6 9 6 6 6-6" {...stroke} strokeWidth={2.2} />}
      {name === "sparkle" && (
        <>
          <Path d="M12 2.5l2 5.5 5.5 2-5.5 2-2 5.5-2-5.5-5.5-2 5.5-2z" fill={color} />
          <Path d="M19 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" fill={color} />
        </>
      )}
      {name === "copy" && (
        <>
          <Rect x={9} y={9} width={11} height={11} rx={2.5} {...stroke} strokeWidth={2} />
          <Path d="M5 15V6a1.5 1.5 0 0 1 1.5-1.5H15" {...stroke} strokeWidth={2} />
        </>
      )}
      {name === "lock" && (
        <>
          <Rect x={5} y={10.5} width={14} height={10} rx={2.5} {...stroke} strokeWidth={2} />
          <Path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" {...stroke} strokeWidth={2} />
        </>
      )}
      {name === "torch" && <Path d="M13 2.5 5 13.5h6l-1 8 8-11h-6z" fill={color} />}
      {name === "play" && <Path d="M6 3.5v17L20.5 12z" fill={color} />}
    </Svg>
  )
}
