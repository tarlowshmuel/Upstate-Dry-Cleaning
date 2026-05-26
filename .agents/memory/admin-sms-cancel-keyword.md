---
name: Admin SMS cancel keyword
description: Why new numeric-input admin SMS steps must use "cancel", not "0", as the abort word.
---

The admin SMS handler has a universal early guard that treats the text `"0"` (along with `menu`, `back`, `help`, empty) as "reset to main menu" before any step handler runs.

**Why:** This means any new admin step that accepts `0` as valid numeric data — e.g. `$0 delivery fee`, `0% wholesale`, `$0 order minimum`, `$0 price-list item` — will silently lose that input. The validator never sees it; the user just bounces back to the main menu with no error.

**How to apply:** For any admin step that takes a free-text number where `0` is a legitimate value, use `"cancel"` as the abort keyword instead of `"0"`, and check `if (text === "cancel")` at the top of the step handler before validating. Update the prompt copy to say `Reply "cancel" to abort` (not `"0" to cancel`). Numbered-choice submenus (1/2/3 picks) can keep `0 = back` because `0` isn't valid data there.
