import { Pressable, Text, View } from "react-native"
import Animated, { FadeInDown } from "react-native-reanimated"
import type { Question, QuestionAction } from "@server/protocol"
import { t } from "@/lib/i18n"
import { font, radius, space, useTheme } from "@/theme"
import { Icon } from "./art"

const LEADING_EMOJI = /^((?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*)\s+/u

/**
 * A question the agent asked: tap an option, tick several and press Done, or type your own answer in the
 * composer below.
 */
export function QuestionCard({ question, onAction, onTypeOwn }: { question: Question; onAction: (a: QuestionAction) => void; onTypeOwn: () => void }) {
  const { c } = useTheme()
  const field = question.fields[question.index]
  if (!field) return null
  return (
    <Animated.View
      entering={FadeInDown.duration(220)}
      style={{
        marginLeft: 36,
        backgroundColor: c.surface,
        borderColor: c.questionBorder,
        borderWidth: 1.5,
        borderRadius: radius.card,
        borderCurve: "continuous",
        padding: 14,
        boxShadow: c.shadow,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name="sparkle" size={16} color={c.primaryText} />
        <Text style={{ flex: 1, color: c.primaryText, fontSize: 11.5, fontWeight: "800", letterSpacing: 0.9, textTransform: "uppercase" }}>{t("questionLabel")}</Text>
        {question.total > 1 && (
          <Text style={{ color: c.textMuted, fontSize: font.size.caption, fontVariant: ["tabular-nums"] }}>{t("questionCount", { index: question.index + 1, total: question.total })}</Text>
        )}
      </View>
      <Text selectable style={{ color: c.text, fontFamily: font.rounded, fontSize: 18, lineHeight: 24, marginTop: 6, marginBottom: field.question ? 4 : 10 }}>
        {field.title}
      </Text>
      {!!field.question && field.question !== field.title && (
        <Text selectable style={{ color: c.text, fontSize: font.size.label, lineHeight: 21, marginBottom: 10 }}>
          {field.question}
        </Text>
      )}
      <View style={{ gap: 7 }}>
        {field.options.map((o, i) => {
          const ticked = field.multiple && question.selected.includes(i)
          const emoji = o.label.match(LEADING_EMOJI)
          const label = emoji ? o.label.slice(emoji[0].length) : o.label
          return (
            <Pressable
              key={i}
              onPress={() => onAction(field.multiple ? { type: "toggle", option: i } : { type: "pick", option: i })}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                backgroundColor: ticked ? c.primarySoft : pressed ? c.border : c.surfaceAlt,
                borderColor: ticked ? c.primary : c.border,
                borderWidth: 1,
                borderRadius: 15,
                borderCurve: "continuous",
                paddingHorizontal: 12,
                paddingVertical: 11,
              })}
            >
              {emoji && <Text style={{ fontSize: 18, width: 22, textAlign: "center" }}>{emoji[1]}</Text>}
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: c.text, fontSize: font.size.label, lineHeight: 20, fontWeight: "600" }}>{label}</Text>
                {!!o.description && <Text style={{ color: c.textMuted, fontSize: 12.5, lineHeight: 16 }}>{o.description}</Text>}
              </View>
              {field.multiple ? (
                <View style={{ width: 22, height: 22, borderRadius: 7, borderWidth: 2, borderColor: ticked ? c.primary : c.borderStrong, backgroundColor: ticked ? c.primary : "transparent", alignItems: "center", justifyContent: "center" }}>
                  {ticked && <Icon name="check" size={15} color={c.onPrimary} />}
                </View>
              ) : (
                <Icon name="chevron" size={16} color={c.textMuted} />
              )}
            </Pressable>
          )
        })}
      </View>
      {field.multiple && (
        <Pressable
          onPress={() => onAction({ type: "submit" })}
          disabled={!question.selected.length}
          style={({ pressed }) => ({ marginTop: 10, alignItems: "center", backgroundColor: c.primary, opacity: question.selected.length ? (pressed ? 0.85 : 1) : 0.4, borderRadius: 15, paddingVertical: 11 })}
        >
          <Text style={{ color: c.onPrimary, fontFamily: font.rounded, fontSize: font.size.label }}>{t("questionSubmit")}</Text>
        </Pressable>
      )}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 12, marginBottom: 8 }}>
        <View style={{ flex: 1, height: 1, backgroundColor: c.borderStrong }} />
        <Text style={{ color: c.textMuted, fontSize: font.size.caption }}>{t("questionOr")}</Text>
        <View style={{ flex: 1, height: 1, backgroundColor: c.borderStrong }} />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Pressable
          onPress={onTypeOwn}
          style={({ pressed }) => ({
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: space.sm,
            borderWidth: 1.5,
            borderStyle: "dashed",
            borderColor: c.borderStrong,
            borderRadius: 15,
            paddingLeft: 12,
            paddingRight: 10,
            paddingVertical: 10,
            backgroundColor: pressed ? c.surfaceAlt : "transparent",
          })}
        >
          <Text style={{ color: c.textMuted, fontSize: 14.5 }}>{t("questionOwn")}</Text>
          <Icon name="send" size={18} color={c.primaryText} />
        </Pressable>
        <Pressable onPress={() => onAction({ type: "skip" })} hitSlop={8} style={{ paddingHorizontal: space.xs }}>
          <Text style={{ color: c.textMuted, fontSize: font.size.small, fontWeight: "600" }}>{t("questionSkip")}</Text>
        </Pressable>
      </View>
    </Animated.View>
  )
}
