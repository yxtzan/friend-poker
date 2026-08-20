import { EntryScreen } from "./components/entry-screen.js";
import { TableShell } from "./components/table-shell.js";
import { useTableApp } from "./state/use-table-app.js";

export function App() {
  const app = useTableApp();
  const tableReady =
    app.identity !== null &&
    app.projection !== null &&
    ["CONNECTED", "RECONNECTING", "DISCONNECTED", "ERROR"].includes(app.phase);

  if (!tableReady) return <EntryScreen app={app} />;

  return (
    <TableShell
      projection={app.projection}
      viewerId={app.identity.playerId}
      phase={app.phase}
      pendingCommand={app.pendingCommand}
      uncertainCommand={app.uncertainCommand}
      notice={app.notice}
      onCommand={(command) => app.submitCommand(command)}
      onRetryUncertain={() => void app.retryUncertainCommand()}
      reactions={app.reactions}
      reactionEggVisible={app.reactionEggVisible}
      onReaction={app.sendReaction}
      soundEnabled={app.soundEnabled}
      onSoundEnabledChange={app.setSoundEnabled}
    />
  );
}
