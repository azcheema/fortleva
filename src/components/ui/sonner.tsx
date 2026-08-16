"use client"

import { Toaster as Sonner, type ToasterProps } from "sonner"
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from "lucide-react"
import { useEffect, useState } from "react"

/**
 * The toast surface follows the RESOLVED theme, not a hardcoded one:
 * sonner paints its own background, so a light toast over a dark app is
 * the one place the theme can visibly disagree with itself.
 *
 * Resolution is read from the <html> class the layout (or the pre-paint
 * script) already set, and re-read when the OS preference flips.
 */
function useResolvedTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">("light")

  useEffect(() => {
    const read = () =>
      setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light")
    read()
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    media.addEventListener("change", read)
    return () => {
      observer.disconnect()
      media.removeEventListener("change", read)
    }
  }, [])

  return theme
}

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useResolvedTheme()

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4 text-(--tone-success-line)" />,
        info: <InfoIcon className="size-4 text-primary" />,
        warning: <TriangleAlertIcon className="size-4 text-(--tone-caution-line)" />,
        error: <OctagonXIcon className="size-4 text-destructive" />,
        loading: <Loader2Icon className="size-4 animate-spin text-muted-foreground" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius-card)",
          "--shadow": "var(--shadow-2)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
