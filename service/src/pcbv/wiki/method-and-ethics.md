# Method and ethics

Work on hardware goes well when you work slowly, keep a record and make only changes that you can undo.
Work only on boards that you have the right to open. This page describes the working method that the app
supports, and the limits that come with the work. Laws differ by country. The principles below are
common ground. They do not replace legal advice.

## Working method

- **Record before you change.** Photograph the board, capture the boot log and back up the flash before
  you write anything. The app records events, captures and measurements in the folder of the board for
  this reason.
- **One change at a time.** Make a change, look at the result and write it down. If you make two changes
  at once, you cannot tell which one had the effect.
- **Hypotheses, then measurements.** Write down what you expect a pin to be, then measure it. The app
  marks assistant suggestions as guesses until a measurement confirms them. Treat your own guesses the
  same way.
- **Prefer reading to writing.** Reading a console, a log or a flash chip leaves the board as it was.
  Writing flash, bootloader variables or EEPROMs can make the board unusable. Write only when you have a
  verified backup and a known way to restore it.
- **Keep the record private until it is clean.** Boot logs and dumps contain serial numbers, MAC
  addresses, keys and sometimes passwords. Your data repository is private. Redact anything that you
  publish first.

## Whose board it is

- Work on hardware that you own, or that you have written permission to test.
- Internet providers often own the routers that they supply, including many DSL and fibre routers and the
  Nimbus. They rent them to you. Check your contract before you open one. A change to the board can end
  your service or break your agreement.
- The employer owns hardware that you use at work, whatever is on your desk.

## Networks and accounts

- The console of a router can show credentials for the network of the provider, such as TR-069
  management, VoIP or PPP accounts. If you use them to reach the systems of the provider, that is
  unauthorised access. It does not matter how you found them.
- Keep boards that you investigate off networks that you do not control, or isolate them on a separate
  segment.

## Copyright and licences

- Firmware has a copyright. Many jurisdictions accept that you analyse your own copy for
  interoperability, security or repair. They usually do not accept that you redistribute the firmware or
  a dump.
- Routers often run GPL software (Linux, BusyBox, U-Boot). On request, the vendor must give you the
  corresponding source code. It is often the best documentation available.
- The EU, the US and other countries restrict the circumvention of copy protection (DRM), even on
  hardware that you own.

## Before you publish

Board folders hold serial numbers, MAC addresses, credentials and photos of labels. To share a board,
make a redacted copy and publish the copy:

```
pcbv redact nimbus-n100 --check
pcbv redact nimbus-n100 --out ~/share/nimbus
```

If `pcbv` is not on your PATH, run the commands as `uv run pcbv ...` in the service folder.

1. Run the first command. It lists what the app would replace and writes nothing.
2. Add each string that the list misses to `.pcbv/redact.txt` in the board folder, one per line.
3. Run the second command. It writes the copy with a `REDACTION.md` report.
4. Look at every photo and read the copy before you publish it.

The rules cannot know some strings, such as the serial number on the label of the board. The app never
commits `.pcbv/redact.txt`.

## Reporting what you find

When you find a vulnerability:

1. Write it up with the board model, the firmware version and the exact steps.
2. Report it privately to the vendor, through their security contact or bug bounty programme. If the
   vendor has none, report it through a national CERT.
3. Allow time for a fix before you publish. 90 days is a common default.
4. Publish without customer data, keys or credentials from your unit.

Related: [Bench safety](safety), [Firmware images](firmware-basics), [Start here](start-here).
