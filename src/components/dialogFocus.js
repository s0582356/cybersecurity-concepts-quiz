// Fokusfalle für modale Dialoge (Phase 3D): Tab/Shift+Tab bleiben im Dialog, auch wenn der Fokus noch auf dem
// Dialog selbst liegt. Gleiches Verhalten wie im Abgabe-Dialog (ExamSubmitPanel).
export function trapTabFocus(event, panel) {
  const controls = [...panel.querySelectorAll('button:not(:disabled)')]

  if (controls.length === 0) {
    event.preventDefault()
    panel.focus()
    return
  }

  const first = controls[0]
  const last = controls[controls.length - 1]
  const inside = panel.contains(document.activeElement) && document.activeElement !== panel

  if (event.shiftKey && (document.activeElement === first || !inside)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (document.activeElement === last || !inside)) {
    event.preventDefault()
    first.focus()
  }
}
