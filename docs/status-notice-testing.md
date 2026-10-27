# Status notice acceptance recipe

Use an isolated test principal and resources for these checks. Do not stop a
shared machine, change another principal's sessions, or send malformed requests
outside the test principal's own authenticated edge session. The recipes below
use existing Salon behavior and require no product code or special build.

For each notice, open the installed client as the test principal. On a phone,
the notice appears at the right side of the status-count row. With the
persistent count row enabled, the counts remain beneath the notice; with it
disabled, the row appears only while the notice is visible. On desktop and
native macOS, the notice appears at the right end of the title bar. It must not
float over the conversation or add a row below the header. Dismiss with the
close button to repeat sooner where noted.

## Host offline

1. Have Ops provision a test-only endpoint/profile and an active machine entry
   with a unique display name, visible only to the test principal in its client
   configuration. Before acceptance, Ops must verify from the edge that the
   endpoint's probe stalls for more than 1,000 ms before failing. The breaker
   ignores failures shorter than its default 1,000 ms threshold; an unreachable
   documentation-network address or immediate connection refusal is not enough.
   Keep all other configured machines unchanged; do not stop or reconfigure a
   shared host.
2. Open or reload the client, allow its initial successful load, then wait for
   the verified stalled probe to fail and open the breaker. On a subsequent
   poll while the breaker is cooling down, the notice text is
   `<test-machine>: offline (cooling down after a failed probe)`.
3. Confirm the placement above. The notice auto-dismisses after 8 seconds.
   While that machine remains down, it is suppressed for 120 seconds from the
   previous display. Host-offline notices wait for the first successful load
   or 5 seconds from hook mount, whichever is later; failures before then do
   not display a notice. After 120 seconds, the next polling update can display
   it again.
4. Remove the test machine entry when finished.

The machine name must be one of the configured names: the client only treats
known-machine failures as host-offline notices. The edge's failed-probe breaker
produces the cooling-down reason without requiring a real host to be stopped.

## Attention

1. Use a disposable session on a test-only machine whose daemon does not expose
   title revision support. Keep other machines and sessions unchanged.
2. In the installed client, edit that session's title and save a non-empty
   title. The existing title update flow refuses to send a write without title
   revision support and reports `session daemon does not expose title revision
   support`. The client surfaces the error as an `attention` status notice.
   Confirm it appears in the status-count row on phone and at the title-bar end
   on desktop/native macOS.
3. Attention notices do not auto-dismiss and are not subject to the host-offline
   120-second repeat suppression. Close the notice to clear it. Repeat the
   request to show it again, then remove the disposable session if desired.

Only use the test principal's own disposable session and test-only machine. The
failed title update leaves the session title unchanged.

## Phone history unavailable

1. Use an isolated test principal with a machine that has no conversation
   history capability (for example, a test-only machine whose configured
   daemon does not expose the history API). Create or select a session on that
   machine. Do not disable history on a shared machine.
2. On a phone, set **Open session as** to **Conversation**, then select the
   session from the overview. Since that machine is not in the client's
   history-capable machine set, the phone opens its terminal and shows
   `Conversation history is unavailable for this session. Opened terminal.`
3. Confirm the notice uses the phone status-count row. It remains until
   dismissed with the close button or another status notice takes precedence;
   this informational notice has no timed auto-dismiss or repeat-suppression
   window. Select the session again to reproduce it.

This fallback is phone-only; it does not appear on desktop or native macOS.

## Source behavior

The edge machine probe reports a cooling-down error after a failed probe;
`useStatusNotice` recognizes errors for configured machine names and applies
the 8-second expiry, 120-second repeat window, and 5-second startup grace.
The title controller reports an attention error when the daemon lacks title
revision support. The phone fallback is selected when a session's machine is
not in `historyMachineNames`. All three notices flow through the existing
header placement.
