# Contributing

First of all, thank you for taking the time to read this. It means you're considering contributing to one of my projects — and that genuinely matters to me.

## Who I am and why this exists

I'm a backend and systems developer. I build tools — mostly because I need them, and sometimes because I get frustrated that nothing out there does exactly what I want without dragging along a mountain of complexity I didn't ask for.

My projects exist because they solved a real problem for me. They're designed to be **lightweight, easy to integrate, and honest about what they do**. I care about optimization, but never at the cost of core functionality — that's exactly the kind of tradeoff that pushes me away from many professional solutions. If a feature makes the tool harder to understand or harder to use, it's probably not worth it.

I like to understand the tools I work with, deeply. I expect the same curiosity from people who contribute here. You don't have to know everything — but you should want to.

---

## Code of conduct

This community runs on a simple principle: **be decent to each other**.

I don't expect everyone to agree. In fact, I expect the opposite — technically skilled people tend to have strong opinions and can be stubborn (myself included). That's fine. Disagreement is productive. But it requires a constant effort of **comprehension, tolerance, and ego management**.

What I won't tolerate:
- Hostility, condescension, or dismissiveness toward other contributors
- Behavior that makes this space uncomfortable for others or for me

I reserve the right to remove any member whose behavior is inappropriate or disruptive — to the community or to me personally. There's no appeals process for that.

---

## What you can contribute

All forms of contribution are welcome:

- **Bug reports** — Something's broken? Tell me.
- **Feature requests** — Have an idea? Let's talk about it.
- **Documentation** — Often the most underrated contribution.
- **Tests & benchmarks** — Always appreciated, especially if they reveal something.
- **Translations** — If you want to make the project accessible to more people.
- **Code** — Of course.

A note on **reviews and corrections**: I prefer that feedback on PRs comes from people who have already contributed actively to the project. I want to avoid people who show up only to critique, or who try to take ownership of someone else's effort. If you're new here, start by contributing before reviewing.

---

## Git workflow

I care about history. Real history — not a rewritten, sanitized version of it.

### Merge strategy

- **Merges over rebases.** I want to see what actually happened, not what someone wished had happened.
- **Non-fast-forward merges** are preferred. They preserve the branch structure and make it clear on which version a ticket was resolved.
- **Squash with caution.** It can be useful to clean up meaningless save-state commits with no real progress, but it should never be applied to a significant branch. Squashing a week of work into one commit destroys context.

### Branch naming

Use the following format:

```
{group}/{alias}/{topic}
```

- **group** — the type of work: `feat`, `fix`, `chore`, `release`, `docs`, `test`, etc.
- **alias** — something that identifies you as the author (your GitHub handle, initials, whatever you use consistently)
- **topic** — a short, free-form description of the work

Examples:
```
feat/alex/user-auth
fix/jdoe/connection-pool-leak
chore/sam/update-ci-deps
```

### Publish early

**Favor small, focused branches.** Don't disappear for three weeks and resurface with a 2,000-line PR.

Open a **draft PR as early as possible**, even if the work isn't done. It signals what you're working on, invites early feedback, and dramatically reduces the chance of a rejection. A PR that surprises everyone is a PR at risk.

---

## Opening an issue

I don't have formal templates. I don't want the friction of a strict template to discourage someone from reporting a bug.

That said, a good issue saves everyone time. When in doubt, include:

- What you expected to happen
- What actually happened
- How to reproduce it (minimal example if possible)
- Your environment (OS, version, runtime)

For feature requests: explain the problem you're trying to solve, not just the solution you have in mind. Context helps more than a spec.

If your issue is vague, I'll ask for more detail. That's not a rejection — it's a conversation.

---

## Submitting a pull request

Before submitting, ask yourself:

- [ ] Is there an open, accepted issue for this? If not — did you discuss it first?
- [ ] Do the existing tests still pass?
- [ ] Did you add tests for the new behavior? (See below.)
- [ ] Is documentation up to date?
- [ ] If performance-relevant, did you run benchmarks?

**If you skipped any of these**, that's okay — but explain why in the PR description. "I didn't add tests because this only affects the build pipeline" is fine. Silence is not.


---

## Code style

In case no linter are configured, the rule is simple: **match what's already there**.

Read the existing code. Understand its style. Integrate into it — don't reformat it to match your preferences.

Beyond formatting, I pay close attention to:

- **Readability** — Can someone who didn't write this understand it quickly?
- **Function length and complexity** — If a function is doing too much, it probably needs to be split.
- **Naming** — Names should reflect intent, not implementation.
- **Unnecessary complexity** — If there's a simpler way, use it.

---

## Development environment

I change environments often, so I've made a point of keeping setups lightweight and self-contained. Everything you need to get started is in the `README`.

If you run into something that isn't documented and blocks you — open an issue or reach out to an active contributor. If the setup is broken or confusing in a way that isn't documented, that's a real bug and worth filing.

---

## Recognition

Every contributor is credited in the `CHANGELOG` at release time.

Recurring contributors might also appear in the `README` as well.

For contributors, I'll ask for:
- A **real first name** (minimum) — aliases are fine for commits, but I want to know who's in this community
- A **real email address** (personal or professional) — this is how I'll reach you if needed and how attribution is tracked

You can use an alias in your git commits. But when it comes to the community and the changelog, I want real people behind the names.

---

*This document reflects how I like to work. It will evolve. If something here is unclear or feels off, open an issue — that's a valid contribution too.*
