# Store listing drafts

Text to paste into Partner Center when submitting `photos.jpeg` (Store ID 9PP33VMQ9Z5J). These are drafts: read them, change what is not true for the version you submit, and fill in what only you can decide (marked **TODO**).

| File | Partner Center field |
|---|---|
| `description.md` | Store listing: description, what's new, product features, short description, search terms |
| `privacy.md` | Properties: privacy policy. It must be at a public web address: put this page on GitHub Pages, the repository's wiki or any site you own, and paste the address |
| `age-rating.md` | Age ratings questionnaire: the answers that follow from what the app does |
| `submission-notes.md` | Notes for certification, and the justification for the restricted capability |

Screenshots (at least one, 1366×768 or larger, PNG): take them from the installed app on photos you are happy to publish. None are in this repository, because the only real photos to hand while this was written were private ones.

Package: `windows\package-store.ps1` writes `windows\build\photos.jpeg-<version>-x64.msix`. Upload that file as it is; the Store signs it.
