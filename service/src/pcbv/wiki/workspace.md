# The workspace

The board screen has panels: Board, Header, Photo, Notes, Playbook, Wiki, Console, Timeline,
Logic, Terminal and, when the assistant is on, Agent. A **workspace** is a named arrangement of these panels.
Learn, Console, Analysis and Wall come with the app. Open the **Workspace actions** menu (⋯) and choose **Save as…** to keep your own. **Reset layout** in the same menu puts a built-in workspace back as it started.

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

## The save chip

The chip at the right of the top bar shows whether your last change is saved, for example "Saved 18:16".
If a change could not be saved, it says "Not saved" and the reason is in its tooltip. Press the chip for its
menu. It can undo or redo a change, copy the path of the board folder and open the folder.

## Undo and redo

`Ctrl+Z` undoes your last change to the board in this window. `Ctrl+Shift+Z` or `Ctrl+Y` does the change
again. The save chip's menu has the same steps as **Undo** and **Redo**, with the name of the change.

- Undo works on the changes that you made in this window since you opened the board. That includes
  photos, headers, pins, readings, callouts, playbook steps, the board details and the notes. A run of
  typing in the notes is one step.
- Undo does not change what the CLI, another window or the assistant did. Console captures and logic
  captures stay.
- If something else changed the same item after you, undo stops and tells you. Change the item by hand.
- In a text field, `Ctrl+Z` undoes your typing in that field.
- The list of changes starts empty again when you choose another board or reload the window. It also
  starts empty when the app loads the board again after a connection problem.
- The tutorial turns undo off.

Next: [Settings and privacy](settings-and-privacy) covers the other switches in the top bar.

## The Notes panel

The Notes panel holds the notes of the board. The Board panel shows the first line of the notes. Press it to
open the Notes panel.

- **Edit** shows the text. **Preview** shows the text with its formatting. **Split** shows both side by
  side. Split needs a panel at least 720 pixels wide.
- The buttons **Heading**, **Bold**, **List**, **Checklist**, **Code** and **Link** add Markdown to the
  selected text. `Ctrl+B` makes bold text and `Ctrl+K` makes a link.
- **Add dated entry** starts a new line with the date and the time, for example `- 2026-11-05 18:16`. The
  command `pcbv note` writes lines in the same form.
- A line that starts with `- [ ]` is a task. In the preview, tick the box to change it to `- [x]`.

The panel saves the text one second after you stop typing, and when you leave the field. The notes can
have 100,000 characters. The panel shows a count from 90,000.

## The Photo panel

The Photo panel shows one photo of the board with its markers and callouts. Each photo has a tab. A new
photo is named "Photo 2", "Photo 3" and so on.

- Add a photo with **Add photo**, or drop an image file on the photo. You can also paste an image with
  `Ctrl+V` while focus is in the panel. The photo must be a JPEG, PNG or WebP file. The panel adds one
  photo at a time.
- The menu button next to a tab has **Rename**, **Rotate left**, **Rotate right** and **Remove photo**.
  **Rename** changes the name of the tab. **Rotate left** and **Rotate right** turn the photo by a
  quarter. The markers, callouts and pin grids on it turn with it. **Remove photo** asks first. It also
  removes the markers and callouts on that photo. The photo files stay in the board folder.
- Select a box and drag one of its eight handles to change its size. The box stays inside the photo.
- With a marker or callout selected, the arrow keys move it by one screen pixel. `Shift` with an arrow
  key moves it by ten. The panel saves the move after a short pause.
- `Ctrl` with the mouse wheel zooms at the pointer. The keys `+` and `-` zoom, and `0` fits the photo to the
  panel.
- To move the photo in the panel, drag with the middle mouse button. You can also hold `Space` and drag
  with the left button.
