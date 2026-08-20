# Friend Poker Web Visual Direction

M10.5 establishes a compact, tactile game-room interface rather than a landing
page or dashboard. M12 adds secondary reference surfaces and small social
feedback without competing with the felt, seats, cards, board, pot, and action
dock.

- Temperament: calm, direct, social, mature, and suitable for a late-night friends' game.
- Hierarchy: felt table, seats, cards, board, and pot own the screen; metadata and presence controls stay on the edge.
- Type: modest title, readable compact player names, emphasized chip/pot numbers, small translated status text, and no hero-scale copy.
- Material: near-black room, warm dark rail, muted green felt, warm off-white cards, soft text, restrained gold for focus and dealer context.
- Density: keep useful values close to the object they describe; avoid repeated labels, dashboard cards, and decorative explanation.
- Shape: oval table, rail-attached seat plates, card proportions, circular dealer marker, restrained rectangular controls.
- Seat relationship: every seat is spatially attached to the rail; the viewer seat and hole cards remain visibly connected to that seat.
- Gameplay dock: current-viewer actions sit immediately below the felt, expose only server-approved legal actions, and use one compact Raise-to control with Pot quick buttons.
- Host controls: Session and host-management actions stay in a collapsible secondary rail below presence; destructive actions require an explicit confirmation surface.
- Secondary surfaces: the static 10-level hand-ranking reference and safe recent hand/Session history use a right-side drawer on desktop and a bottom sheet on narrow screens; they are opened on demand and do not become dashboard cards.
- Social feedback: six fixed emoji reactions are small, transient, and anchored to a seat when possible; the local “你急了” cooldown feedback is short-lived and never changes table state.
- Sound and motion: sound is opt-in after an explicit click and consists only of restrained Web Audio cues; turn/street/result/card transitions stay short and disappear under reduced-motion preferences.
- Street presentation: accepted safe-projection advances reveal only the newly dealt flop, turn, or river cards in a short, non-blocking table overlay; reconnects, stale projections, and already-progressed hands do not replay it.
- Hand result: the newest completed safe hand stays as a compact in-table result panel until explicitly closed or the next hand starts; it preserves actual main/side-pot payouts, ties, odd chips, and only legally revealed showdown cards.
- Responsive behavior: preserve the same table and spatial relationships on desktop, portrait, and landscape; compress metadata before shrinking gameplay information into illegibility. Narrow layouts must not introduce horizontal overflow.
- Accessibility: secondary surfaces have dialog labels, Escape close, focus return, keyboard-visible controls, and reduced-motion fallbacks; emoji buttons have Chinese accessible labels. Frequently tapped game controls and decorative cards/reaction effects suppress accidental text selection without disabling selection in history, result text, nicknames, or form fields.
- Avoid: marketing heroes, SaaS eyebrow copy, card walls, excessive pills, glassmorphism, neon casino styling, generic dashboard panels, and decorative copy that explains obvious UI.
