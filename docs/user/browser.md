# Private host browser

Browser is a built-in plugin enabled by default. Turning it off is a saved
workspace choice. Enabling the plugin does not install its host service or give
one member access to another member's login.

The service uses the VPS's normal Chrome or Chromium in headed mode, with a
private virtual display and persistent profile for each workspace/member pair.
Chat, Codex and explicitly granted file plugins use the same service. Your login
can carry between those consumers after you approve their access.

## Use Browser

1. Ask the bot to open a website in your private conversation. For a Codex task,
   ask it to use Browser while working on the authorized repository.
2. Open **Browser** from the task's Telegram message. Telegram verifies your
   identity; no panel account or earlier remote-desktop login is required.
3. Review the task and destination before approving site access or an interaction.
   Site consent lasts 30 minutes. Another task or plugin needs its own consent.
4. Enter requested passwords, codes and similar values on that page. The field
   clears when submitted. A confirmed submission resumes the originating task.
   Do not send these values in chat.

The same page shows pending and completed requests, your session's controller,
private screenshots and available downloads. **View browser** does not interrupt
an outstanding input request. Screenshot fields are masked.

**Take control** explicitly interrupts the current controller and cancels any
outstanding input request. While you have control, open a website, view its current
screen, click a position, use Tab/Enter or scroll. To type privately, focus the
remote field and choose **Enter private value**. Verify its destination in the
new input request. **Return control** lets approved tasks continue. Refresh the
view after a page changes; clicks and keys are bound to the displayed page.

**Close browser** stops current browser requests and preserves saved login.
**Delete profile** revokes existing browser access and removes the profile,
cookies and downloads when host cleanup completes. Retained task history follows
the workspace's separate retention policy; deleting a profile does not unsend
messages already delivered.

## Permissions and limits

- A copied launch link locates the workspace; it does not authorize its holder.
  Each request checks the signed Telegram user and current membership. A panel
  administrator cannot select or inspect someone else's profile.
- Browser is for private, interactive tasks. Group and scheduled tasks cannot
  borrow a person's authenticated browser. The same person in a second workspace
  has a separate profile.
- Page content may enter the authorized task's model context and private history.
  Password/code submissions go directly to the bound browser field and do not
  enter model messages, chat history or routine logs. The destination website
  receives the value and controls its own storage.
- Website content cannot grant permission. Clicks, filling ordinary fields,
  key presses and coordinate clicks require a reviewed task action or your own
  explicit manual gesture. Browser has no arbitrary JavaScript, host-file upload
  or public debugging interface.
- Only approved origins can connect. Login providers, redirects and asset domains
  may require additional consent. Private/metadata destinations are blocked.
  Local previews require matching operator configuration and member consent.
- Four active browsers, eight tabs per browser, twenty accepted downloads and
  25 MiB per download are the default limits. Input requests expire after ten
  minutes. Idle browsers close after five minutes and preserve login. Artifact
  references expire after 24 hours; screenshots retain the latest fifty.
- An uncertain operation is not automatically retried. Check the current page
  and obtain a fresh decision instead of assuming success or submitting twice.
- Headed mode does not guarantee every website's sign-in challenge will work.
  File upload and secure input into cross-origin frames are unavailable; flows
  requiring a hardware key or approval on another device need that site's
  supported account-verification method.

## Plugin configuration

Open **Plugins → Browser** in the admin panel to enable/disable the integration
and review the host-service configuration status. A configured socket is checked
when used; the panel does not claim that an unavailable service is healthy.

Local preview origins use the saved summary's **Edit** dialog. Enter complete
loopback origins such as `http://127.0.0.1:5173`, without a path. The development
server must be reachable at that address on the browser host.

For an installed file plugin, **Edit → Allow this plugin to request the member's
Browser** is off by default. Grant only reviewed code. That permission does not
skip member consent or share profiles. File plugins execute trusted server code;
the Browser grant is not a general sandbox for arbitrary extension code.

See [host installation](browser-host.md) for the required deployment service and
[troubleshooting](troubleshooting.md) for general connection problems.
