import { useRef, useState, type ComponentRef, type ReactNode } from "react"
import { KeyboardAvoidingView, View } from "react-native"

/** Keeps its bottom edge above the keyboard, whatever sits above it (a header, the status bar). */
export function KeyboardView({ children }: { children: ReactNode }) {
  const ref = useRef<ComponentRef<typeof View>>(null)
  const [top, setTop] = useState(0)
  return (
    <View ref={ref} style={{ flex: 1 }} onLayout={() => ref.current?.measureInWindow((_x: number, y: number) => setTop(y))}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={top}>
        {children}
      </KeyboardAvoidingView>
    </View>
  )
}
