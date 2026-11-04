# The workspace

The board screen has panels: Board, Header, Changes, Photo, Playbook, Wiki, Console, Timeline, Logic,
Terminal and, when the assistant is on, Agent. A **workspace** is a named arrangement of these panels.
Learn, Console, Analysis and Wall come with the app. **Save as** keeps your own.

## Where a panel can be

A panel is in exactly one of three places:

- **Docked** in one of four regions: Left, Centre, Right or Bottom. A region shows its panels as tabs or
  stacked. The button at the right of the bar of the region switches between the two. An empty region
  folds away. When you drag a panel by its tab or grip, the empty regions open with a dashed outline, so
  you can drop the panel there.
- **In its own window.** The window shows that panel only. When you close the window, the panel returns to
  the region it came from.
- **Put away.** The panel stays out of sight until you show it again. The app deletes nothing. The data of
  the panel stays in the board.

## The Panels menu

The **Panels** button in the top bar lists every panel in the same order. For each panel it shows where
the panel is and what you can do with it:

| Where it is | Actions |
|---|---|
| Docked (Left, Centre, Right, Bottom) | **Show** brings its tab to the front and moves focus to it. **Open in own window.** **Put away.** |
| Own window | **Focus window.** **Bring back** returns it to the region it came from. |
| Put away | **Show here** returns it to the region it came from, or to the Right region if it has none. |

Press `Ctrl+Shift+P` to open the menu from the keyboard. Focus moves to the first item. In the menu:

- The arrow keys, `Home` and `End` move between items.
- Type the first letters of the name of a panel to jump to it.
- `Enter` chooses the item.
- `Esc` closes the menu and returns focus to the button.
- `Tab` closes the menu and moves on.

Some browsers keep `Ctrl+Shift+P` for themselves. Firefox opens a private window. The Panels button works
in every browser.

The menu of each panel (the three dots) also has **Put away** and **Open in its own window**, next to the
moves between regions.

## Finding a panel again

If every panel is in a window or put away, the board area says so. It also has a button that opens the
Panels menu. Some links and buttons need a panel that is put away, for example an **Ask** button or a wiki
link. They show the panel first. **Reset** next to the workspace list puts the panels back as the built-in
workspace starts them. It also brings back every panel that was put away.

Layouts belong to this computer. The app saves them in `~/.config/pcbv/workspaces.json`, not in your
boards.

Next: [Settings and privacy](settings-and-privacy) covers the other switches in the top bar.
