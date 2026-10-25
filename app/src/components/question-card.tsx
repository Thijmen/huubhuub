import { Pressable, Text, View } from "react-native"
import Animated, { FadeInDown } from "react-native-reanimated"
import type { Question, QuestionAction } from "@server/protocol"
import { t } from "@/lib/i18n"
import { font, radius, space, useTheme } from "@/theme"
import { Icon } from "./art"

/** A question the agent asked: tap an option, tick several and press Done, or type your own answer. */
export function QuestionCard({ question, onAction }: { question: Question; onAction: (a: QuestionAction) => void }) {
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
        borderRadius: radius.lg,
        borderCurve: "continuous",
        padding: space.lg,
        gap: space.md,
      }}
    >
      <View style={{ gap: space.xs }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.sm }}>
          <Text style={{ flex: 1, color: c.text, fontFamily: font.rounded, fontSize: font.size.heading, lineHeight: font.lineHeight.heading }}>❓ {field.title}</Text>
          {question.total > 1 && (
            <Text style={{ color: c.textMuted, fontSize: font.size.caption, fontVariant: ["tabular-nums"] }}>
              {t("questionCount", { index: question.index + 1, total: question.total })}
            </Text>
          )}
        </View>
        {!!field.question && (
          <Text selectable style={{ color: c.text, fontSize: font.size.body, lineHeight: font.lineHeight.body }}>
            {field.question}
          </Text>
        )}
      </View>
      <View style={{ gap: space.sm }}>
        {field.options.map((o, i) => {
          const ticked = field.multiple && question.selected.includes(i)
          return (
            <Pressable
              key={i}
              onPress={() => onAction(field.multiple ? { type: "toggle", option: i } : { type: "pick", option: i })}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: space.sm,
                backgroundColor: ticked ? c.primarySoft : pressed ? c.surfaceAlt : c.bg,
                borderColor: ticked ? c.primary : c.border,
                borderWidth: 1,
                borderRadius: radius.md,
                borderCurve: "continuous",
                paddingHorizontal: space.md,
                paddingVertical: space.md,
              })}
            >
              {field.multiple && (
                <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: ticked ? c.primary : c.borderStrong, backgroundColor: ticked ? c.primary : "transparent", alignItems: "center", justifyContent: "center" }}>
                  {ticked && <Icon name="check" size={16} color={c.onPrimary} />}
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.text, fontSize: font.size.label, lineHeight: font.lineHeight.label, fontWeight: "600" }}>{o.label}</Text>
                {!!o.description && <Text style={{ color: c.textMuted, fontSize: font.size.small, lineHeight: font.lineHeight.small }}>{o.description}</Text>}
              </View>
            </Pressable>
          )
        })}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
        <Text style={{ flex: 1, color: c.textMuted, fontSize: font.size.small, lineHeight: font.lineHeight.small }}>{t("questionHint")}</Text>
        <Pressable onPress={() => onAction({ type: "skip" })} hitSlop={8}>
          <Text style={{ color: c.textMuted, fontSize: font.size.label, fontWeight: "600" }}>{t("questionSkip")}</Text>
        </Pressable>
        {field.multiple && (
          <Pressable
            onPress={() => onAction({ type: "submit" })}
            style={{ backgroundColor: c.primary, borderRadius: radius.pill, paddingHorizontal: space.lg, paddingVertical: space.sm }}
          >
            <Text style={{ color: c.onPrimary, fontSize: font.size.label, fontWeight: "700" }}>{t("questionSubmit")}</Text>
          </Pressable>
        )}
      </View>
    </Animated.View>
  )
}
