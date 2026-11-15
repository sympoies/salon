# Sign in another device

Use a one-time pairing code when a new browser or native app needs access and another
device is already signed in with your main access token. Pairing creates a separate device
sign-in that you can revoke without changing the main token.

## Pair the new device

1. On the signed-in device, open **More → Settings → Devices**, then choose
   **Sign in another device**. Keep this device open.
2. On the new device, scan the displayed QR with its camera app or open the copied
   sign-in link. You can also choose **Use a pairing code** on the sign-in page and
   enter the code manually. Use only the server you intended to contact.
3. A native app with link integration opens its sign-in confirmation from the link.
   If offered, use **Scan QR** on the connection screen, or **Open in app** on the
   browser landing page. These paths fill the server and code for you.
   Manual entry remains available through **Use a pairing code** with your HTTPS server URL.
   No main access token is needed.
4. For manual or browser entry, enter a device name and choose **Continue**. Check the displayed server and
   account. Compare the short verification string with the signed-in browser.
5. On the signed-in device, approve only the device you have with you. On the new
   device, choose **Sign in as …** only when the account is correct. Both actions
   are required; opening a link alone does not sign in.

Codes expire after a few minutes. Cancel an unexpected request, an incorrect
comparison or a code you no longer need. If a code expires, has already been used,
or its first recipient lost the page, create a new one. A copied link can be
forwarded, so treat it as private until the pairing ends.
Native link and camera integration depend on the consuming app and its operating-system setup.

## Renew or revoke a device

**Settings → Devices** shows your account's device names, creation and last-use
times, expiry and the current device marker. A device sign-in expires after
30 days; using the application does not extend that deadline.

Sign in with the main access token and choose **Renew** before a device expires to
give it 30 days from that action. Expired or revoked devices must pair again.
Renewal is recorded in the server audit. It cannot restore a credential that the
device has already deleted.

Choose **Revoke** to stop one device's access, including its live connections.
Other devices keep working. Revoking the current device signs it out;
signing out a paired browser also revokes its device sign-in. Native sign-out clears
the locally saved credential; use **Revoke** to end that device authorization. Only a main-token
sign-in can pair or Renew devices. A paired device can view the list and revoke
devices belonging to the same account.

The [protocol reference](device-sign-in.md) covers configuration, expiry metadata,
audit fields and security boundaries.
