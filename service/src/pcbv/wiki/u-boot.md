# U-Boot

U-Boot is the most common bootloader on routers and other embedded boards. It starts the hardware, then loads and starts the Linux kernel. If you stop it before it loads the kernel, you get its prompt.

## Getting to the prompt

During boot, U-Boot prints `Hit any key to stop autoboot:` with a short countdown. If you press a key in time, you get a prompt such as `=>`, or a board name followed by `#`. Some vendors change the key or ask for a word. Some set the countdown to 0, and then the console shows no countdown at all.

## Commands that only read

| Command | Shows |
|---|---|
| `help` | the commands this build has |
| `printenv` | all environment variables |
| `version` | the U-Boot version and compiler |
| `bdinfo` | board information: memory, addresses |
| `md.l 0x80000000 40` | memory contents (memory display) |
| `sf probe` | detects the SPI flash |

## Main variables

- `bootcmd`: the command that runs when the countdown ends, for example `bootm 0x9c050000`.
- `bootargs`: the text passed to the kernel, with `console=ttyS0,115200` and the root filesystem.
- `bootdelay`: the countdown in seconds.
- `ipaddr`, `serverip`: the addresses that `tftpboot` uses. This is a common way to load firmware over the network.

## Commands that change the board

`saveenv` (or `env save`) writes the environment to flash. `erase`, `sf erase`, `sf write`, `nand erase`, `nand write`, `mmc erase`, `mmc write` and `ubi write` change the contents of the flash.

`setenv` changes only the running copy. The board forgets the change at the next power cycle, unless you run `saveenv` after it.

The Console of the app refuses these commands until you type the command a second time. Never run them without a verified backup of the flash.

Related: [The boot chain](boot-chain), [Reading a boot log](reading-boot-logs), [Flash and filesystems](flash-and-filesystems), [Bench safety](safety).
