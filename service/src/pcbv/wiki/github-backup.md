# Back up to GitHub

Git backup keeps a copy of your data folder (`~/hw` by default) in a repository on GitHub. It is
optional. Without it, the folder stays on this computer. To turn git on, open Settings, Git. This page
covers the two tasks that the dialog cannot do for you: creating the repository and logging in.

## The repository must be private

The data folder holds everything you document: photos, console captures, logic captures, notes and the
pinouts of your boards. A public repository publishes all of it. Create a new, empty, **private**
repository:

1. Open <https://github.com/new>.
2. Pick a name and choose **Private**.
3. Leave **Add a README file** off. The first sync expects an empty repository.

When you press **Set remote**, the app asks GitHub one question without a login: is this repository
public? The app sends only the owner and the repository name from the address. It sends no token and no
board data. The app refuses a public repository. If GitHub cannot be reached, or answers anything except
"not found", the step fails. Try again. The app never assumes that a repository is private.

The app asks the same question again before every push, from Settings (Test sync) and from `pcbv sync`. If
the repository has become public, or if GitHub cannot be reached, the app pushes nothing. Your commit
stays on this computer. Make the repository private (Settings, Danger Zone, Change visibility), or try
again later.

The check is a hint, not a guarantee. Someone can make a repository public between the question and the
push. Check it now and then under Settings, General on GitHub.

## Log in

Git needs a login before it can read or write the repository. Pick one way.

### GitHub CLI (recommended)

```
sudo pacman -S github-cli
gh auth login
```

Answer the questions: GitHub.com, HTTPS, **Login with a web browser**, and **yes** to "Authenticate Git
with your GitHub credentials". Then use the HTTPS address of the repository,
`https://github.com/<owner>/<repo>.git`.

### An SSH key

```
ssh-keygen -t ed25519
cat ~/.ssh/id_ed25519.pub
```

Copy the public key (the output of `cat`) into GitHub: Settings, SSH and GPG keys, New SSH key. Then run:

```
ssh -T git@github.com
```

When the command asks, accept the host key of GitHub. If the reply is "Hi <name>! You've successfully
authenticated", the key works. Use the SSH address of the repository,
`git@github.com:<owner>/<repo>.git`.

The app never opens a window to ask for a password or for the passphrase of a key. A sync must not wait
for a question that nobody sees. If your key has a passphrase, run `ssh-add` once after you log in to the
computer. The command asks for the passphrase and keeps the key unlocked until you log out.

## What the remote step checks

After you set the address, the app runs `git ls-remote` on it. The command has a 20 second limit and no
terminal, so it never waits for a password. An empty repository passes. A failure shows the last line from
git and one hint:

| Git says | Do this |
|---|---|
| Authentication failed, or could not read Username | Log in first: `gh auth login` |
| Permission denied (publickey) | Add your SSH key to GitHub, or run `ssh-add` if the key has a passphrase |
| Host key verification failed | Run `ssh -T git@github.com` once in a terminal and accept the host key of GitHub |
| Repository not found | Check the address, and check that you are logged in as the owner |

The remote stays set after a failed access check. Fix the login, then press **Set remote** again.

## Restore on a new computer

Clone the repository into the data folder. Then prepare it again. The commit guard is local
configuration, so it does not come with a clone:

```
git clone https://github.com/<owner>/<repo>.git ~/hw
cd ~/hw
pcbv repo init
```

Then open the app. The boards are in the list. Git does not hold photo originals, because they can carry
GPS data. They stay on the computer that took them. See [Settings and privacy](settings-and-privacy) for
what git adds and what leaves the computer.
