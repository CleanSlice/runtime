/**
 * Ensure Playwright browsers are available.
 * Uses system Chromium (PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) if set,
 * otherwise falls back to auto-install.
 */

let installed = false

/** Resolve Chromium executable path — system or Playwright-managed */
export function chromiumPath(): string | undefined {
  return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined
}

export async function ensurePlaywright(): Promise<typeof import("playwright")> {
  const pw = await import("playwright")

  if (installed) return pw

  // Quick check: try launching and closing a browser to verify
  try {
    const browser = await pw.chromium.launch({
      headless: true,
      executablePath: chromiumPath(),
    })
    await browser.close()
    installed = true
    return pw
  } catch (err) {
    const msg = String(err)
    const needsInstall = msg.includes("Executable doesn't exist")
      || msg.includes("browserType.launch")
      || msg.includes("PLAYWRIGHT")
      || msg.includes("executable")

    if (!needsInstall) throw err

    // If system chromium is set but failed — don't try to install, just fail
    if (chromiumPath()) {
      throw new Error(`System Chromium not found at ${chromiumPath()}. Check PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.`)
    }

    console.log(`[playwright] browsers not installed, running: bunx playwright install chromium`)

    const proc = Bun.spawn(["bunx", "playwright", "install", "chromium"], {
      stdout: "pipe",
      stderr: "pipe",
    })

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])

    const exitCode = await proc.exited

    if (exitCode !== 0) {
      console.error(`[playwright] install failed (exit ${exitCode}):`, stderr)
      throw new Error(`Playwright install failed: ${stderr.slice(0, 500)}`)
    }

    console.log(`[playwright] install complete`)
    if (stdout.trim()) console.log(stdout.trim())

    installed = true
    return pw
  }
}
