import { Stack } from "expo-router"
import { ScrollView, Text, View } from "react-native"
import type { SpendingPeriod } from "@server/protocol"
import { ErrorText, Section } from "@/components/settings-ui"
import { dateTime, money, t } from "@/lib/i18n"
import { useApi } from "@/lib/session"
import { useLoad } from "@/lib/use-load"
import { font, radius, space, useTheme } from "@/theme"

/** What this person spent today and this month, against their limits. */
export default function SpendingScreen() {
  const { c } = useTheme()
  const api = useApi()
  const { data, error } = useLoad(api.spending)
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
      <Stack.Screen options={{ title: t("spending") }} />
      {data && (
        <>
          <Section>
            <Meter label={t("today")} period={data.day} exempt={data.exempt} />
            <Meter label={t("thisMonth")} period={data.month} exempt={data.exempt} last />
          </Section>
          {data.exempt && <Text style={{ color: c.textMuted, textAlign: "center" }}>{t("exempt")}</Text>}
        </>
      )}
      <ErrorText error={error} />
    </ScrollView>
  )
}

function Meter({ label, period: p, exempt, last }: { label: string; period: SpendingPeriod; exempt: boolean; last?: boolean }) {
  const { c } = useTheme()
  const limit = exempt ? null : p.limit
  const share = limit ? Math.min(1, p.spent / limit) : 0
  const color = share >= 1 ? c.danger : share >= 0.8 ? c.primary : c.success
  return (
    <View style={{ padding: space.lg, gap: space.sm, borderBottomWidth: last ? 0 : 1, borderBottomColor: c.border }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" }}>
        <Text style={{ color: c.text, fontSize: font.size.body, fontWeight: "600" }}>{label}</Text>
        <Text style={{ color: c.text, fontFamily: font.rounded, fontSize: font.size.title, fontVariant: ["tabular-nums"] }}>
          {money(p.spent)} <Text style={{ color: c.textMuted, fontSize: font.size.small, fontFamily: undefined }}>{limit ? t("limitOf", { limit: money(limit) }) : t("noLimit")}</Text>
        </Text>
      </View>
      {limit !== null && (
        <View style={{ height: 8, borderRadius: radius.pill, backgroundColor: c.surfaceAlt, overflow: "hidden" }}>
          <View style={{ width: `${share * 100}%`, height: "100%", backgroundColor: color, borderRadius: radius.pill }} />
        </View>
      )}
      <Text style={{ color: c.textMuted, fontSize: font.size.caption }}>{t("resets", { when: dateTime(p.resetsAt) })}</Text>
    </View>
  )
}
