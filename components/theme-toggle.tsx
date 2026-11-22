"use client"

import { useTheme } from "@/components/theme-provider"
import { Toggle } from "@/components/ui/toggle"
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import { faMoon, faSun } from "@fortawesome/free-solid-svg-icons"

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const isDark = resolvedTheme === "dark"

  return (
    <Toggle
      pressed={isDark}
      onPressedChange={(pressed) => setTheme(pressed ? "dark" : "light")}
      variant="outline"
      size="sm"
      className="cursor-pointer"
      aria-label={isDark ? "Gunakan tema terang" : "Gunakan tema gelap"}
      title={isDark ? "Gunakan tema terang" : "Gunakan tema gelap"}
    >
      <FontAwesomeIcon
        icon={isDark ? faMoon : faSun}
        className="h-3.5 w-3.5"
        aria-hidden="true"
      />
      <span className="sr-only">
        {isDark ? "Gunakan tema terang" : "Gunakan tema gelap"}
      </span>
    </Toggle>
  )
}
