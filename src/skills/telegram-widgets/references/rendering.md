# Telegram widget rendering

Verified against Bot API 10.4, November 9, 2026:
- https://core.telegram.org/bots/widgets
- https://core.telegram.org/bots/api#sendwidget

## Runtime and limits

Pass html and caption to send_telegram_widget; width and height are optional.
Omit both dimensions for responsive width and content height. The application
binds the destination, Topic, reply and bot, with allow_queries:false,
is_shared:false and protect_content:true. No secrets or credentials belong in
HTML, links or state. Never paste executable HTML/JS from untrusted sources.
Use supplied or verified facts, label assumptions and snapshots, and escape
source text before embedding it in HTML or JavaScript. Include essential facts
and citations in the caption or final reply. Keep ordinary replies conversational.
Never draw controls promising remote refresh, backend actions or saved changes.

Use inline CSS and JavaScript only. There is no network, external library,
external font, browser storage, iframe or keyboard. TelegramWidget is injected
by Telegram; never load a bridge script. No request(), wallet or bot actions.
Use DOM buttons, inline SVG, canvas, tables, details and summary. Inputs,
selects, textareas, progress/meter, dialog, audio/video, SVG foreignObject,
SVG clipPath/masks and external scripts are unsupported. Use +/- or preset
buttons for calculations instead of inputs. JavaScript is a restricted profile,
not a complete browser. Prefer simple DOM methods and click handlers.

HTML must be 1–32768 UTF-8 bytes, without NUL, and at most 4096 bytes after
zlib level-9 compression. Repeated markup compresses well; random data and
embedded raster images do not. The tool validates sizes locally; Telegram's
compressor can differ slightly near the limit. Simplify if widget_too_large.
The caption is required, plain text, at most 1024 characters. A confirmed
Telegram rejection falls back to the caption; an uncertain send is not retried.
You may revise the staged widget with a new tool call before finishing. Only the
latest presentation publishes. New user input makes the previous presentation
stale: stage a revision for the latest message if it still needs a widget.

## Observable design checks

- Render the first state synchronously. At 320px bubble width, stay comfortably
  below 560px high (Telegram clips at 600px); no internal scrolling or fullscreen.
  Test the same layout at 430px. Use %, flex/grid, em, and system fonts. No vh.
- Use --tg-theme-text-color, --tg-theme-hint-color, --tg-theme-button-color,
  --tg-theme-button-text-color and --tg-theme-secondary-bg-color, without a
  fixed page background. Telegram updates these variables with the chat theme.
- Leave body defaults intact for native padding. A caption below the widget
  keeps the timestamp off its controls. Do not create an extra nested card.
- Use clear text labels and comfortably sized tap targets. Do not rely on
  hover, keyboard input, vertical dragging or accessibility semantics: essential
  meaning must also appear in text. Respect prefers-reduced-motion.
- Empty data must show a useful message. Invalid/nonfinite calculations must
  show a readable error and allow recovery. Label local changes as previews;
  they are not persisted and may reset when the widget leaves the screen.

## Small local calculation example

Adapt this pattern to the request; do not invent data or silently change currencies.
All controls adjust a local estimate and make no bot/backend calls.

```html
<style>
body{font-family:system-ui;color:var(--tg-theme-text-color)}
h3{margin:0 0 .5em}p{margin:.6em 0}
.controls{display:flex;gap:.5em}.controls button{min-height:44px;flex:1}
.hint{color:var(--tg-theme-hint-color)}
</style>
<h3>Local estimate</h3>
<p id="value">3 seats × USD 10 = USD 30</p>
<div class="controls"><button id="less">− seat</button><button id="more">+ seat</button></div>
<p class="hint">Preview only. Nothing is saved.</p>
<script>
let seats=3;
function draw(){document.getElementById('value').textContent=seats+(seats===1?' seat':' seats')+' × USD 10 = USD '+(seats*10)}
document.getElementById('less').onclick=function(){seats=Math.max(1,seats-1);draw()};
document.getElementById('more').onclick=function(){seats=Math.min(100,seats+1);draw()};
draw();
</script>
```

Caption: “Local estimate: 3 seats at USD 10 each totals USD 30. Buttons preview
different seat counts; no purchase or saved change.”

A desktop browser can check layout and clicks with stand-in theme variables,
but does not emulate Telegram's restricted renderer. Native Telegram desktop
and mobile clients remain the final compatibility check.
