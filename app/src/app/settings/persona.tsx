import { Stack } from "expo-router"
import { ScrollView } from "react-native"
import { ChoiceRow, ErrorText, Section } from "@/components/settings-ui"
import { t } from "@/lib/i18n"
import { useApi } from "@/lib/session"
import { useLoad } from "@/lib/use-load"
import { space } from "@/theme"

/** Pick who Huub is: one of the server's personas, or whatever the server's default is. */
export default function PersonaScreen() {
  const api = useApi()
  const { data, error, change } = useLoad(api.persona)
  const fallback = data?.defaultPersona
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
      <Stack.Screen options={{ title: t("persona") }} />
      {data && (
        <Section hint={t("personaHint")}>
          <ChoiceRow
            label={`${t("personaDefault")}${fallback ? ` (${fallback.name})` : ""}`}
            detail={fallback ? undefined : t("personaNone")}
            selected={data.personaId === null}
            onPress={() => void change(() => api.setPersona(null))}
          />
          {data.personas.map((p, i) => (
            <ChoiceRow
              key={p.id}
              label={p.name}
              detail={p.summary}
              selected={data.personaId === p.id}
              onPress={() => void change(() => api.setPersona(p.id))}
              last={i === data.personas.length - 1}
            />
          ))}
        </Section>
      )}
      <ErrorText error={error} />
    </ScrollView>
  )
}
