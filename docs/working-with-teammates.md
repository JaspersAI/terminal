# Working with teammates

You can share a room, or a whole tab, with people you work with. They see it live on their own terminal and can ask its agent. The room stays yours: it runs on your terminal, with your plugins, data, and keys.

Sharing needs a Jaspers sign-in on both sides.

## Teammates

A teammate is someone who accepted your invitation, or whose invitation you accepted. Nobody becomes your teammate, or sees anything of yours, without that.

1. Open **Settings, Team**, set your first and last name, and invite teammates by email (with optional first and last name), or ask Central to invite someone by email. They get an email, and the invitation shows in their own Settings, Team.
2. They accept or decline there, or by asking Central. Until they accept, nothing is shared with them.

Removing a teammate also takes each of you out of the other's shared rooms and tabs.

## Sharing a room or a tab

- **A room:** open the room's menu and use **Share**. Add a teammate by name or `@name`, or type an email address to invite someone new. Or drag a teammate's circle onto the room. To take a member out of a room you own, drag their circle from the foot of the room and drop it outside every room.
- **A tab:** right-click the tab and use **Share**. Every room on the tab is shared, laid out for your teammates as it is for you, and rooms you add later join it.
- **By asking:** tell Central who to share an existing or new room, or a tab, with, by name, `@name`, or email address. It asks you to confirm in its command bar before anything is shared.

If the address is not a teammate yet, they are invited, and they join the room the moment they accept. Until then they are listed as invited.

To stop, use **Stop sharing** in the same place. Your room is untouched; it goes from your teammates' terminals. Deleting a shared room for good stops sharing it too, and so does the last person leaving it when nobody else is invited.

## What a teammate sees and can do

A room shared with you appears on your grid (a shared tab appears as a tab of its own), marked with its owner. In it you can:

- **Ask its agent**, in the room's command line or through Central and Orb. Your question runs on the owner's terminal, under your name, and the answer lands in the room's conversation for everyone.
- **Message the people in it.** Start a message with `@` and someone's name or address (`@Sam Carter`, `@sam`, `@sam@fund.com`, or `@all`). It is filed in the room's conversation and the agent is not asked. Any other message goes to the agent.
- **Use its views.** What you change in a tile (a filter, a note's text) is applied on the owner's terminal and shows for everyone. Data and refreshes come from the owner's terminal.
- **Place its frame** where you like on your own grid, and minimize it.

What you cannot do there: rename it, change its instructions, rearrange or close its tiles, close it, or delete it. Those are the owner's. To take it off your terminal, use **Leave** in its menu.

## When the owner is away

A shared room lives on its owner's terminal. While that terminal is closed or offline, the room stays on your grid as it was last sent and is read-only: you can read it, and anything you ask of it is refused with a line saying its owner is offline. It is live again when they are back.

The circles along the foot of a shared room show who is in it; double-clicking or right-clicking any user circle opens **Settings, Team**. A circle is in color while that person is connected.

## What is sent, and what is not

Your teammates' terminals are sent what they need to draw the room: its title, its tiles and their state, its conversation, and the data its views show. For a plugin they do not have, they are also sent that plugin's compiled views, which run in the same sandbox any plugin view runs in.

Never sent: your API keys and sign-ins, your other rooms and tabs, Central's conversation, your room's instructions and model, and your store. A teammate's view can only read data through the sources your room's own tiles use.

A teammate is an editor of the room. Since they can ask its agent, they can have it do whatever the agent can do for you in that room. Share a room with people you would hand that to.

## Limits to know about

- Two people editing the same text at the same moment: the last change wins.
- A teammate sees the agent's answer when its run ends, not while it works.
- The built-in browser, and a server's own pages, stay on the owner's terminal. In a teammate's copy the tile says so.
