# Licensing

> This is a plain-language summary, not legal advice. The wording of this document, [CLA.md](CLA.md) and
> [TRADEMARKS.md](TRADEMARKS.md) is to be reviewed by a lawyer before the project accepts outside contributions.
> If anything here conflicts with the license texts themselves, the license texts win.

## Default license: AGPL-3.0-or-later

Everything in this repository is licensed under the GNU Affero General Public License, version 3 or (at your option)
any later version (`AGPL-3.0-or-later`). The full text is in [LICENSE](LICENSE).

In short: you may use, study, modify and redistribute the software. If you distribute a modified version, or let other
people interact with a modified version over a network, you must offer them the corresponding source code under the same
license. Read the license text for the exact terms.

The exceptions are third-party material that keeps its own license (see "Third-party material" below) and any file whose
header names a different license.

## Commercial license (dual licensing)

If you want to use, embed or redistribute wg-launcher under terms other than the AGPL (for example inside a
closed-source product), that is possible only under a separate written agreement with the copyright holder. There is
no standard commercial offer yet. To discuss one, contact the project owner through the GitHub account
[maslakovSaveliy](https://github.com/maslakovSaveliy).

Forks that follow the AGPL need no agreement, but must follow the [trademark policy](TRADEMARKS.md).

## Contributions and the CLA

To keep the commercial option above possible, outside contributors sign the Contributor License Agreement in
[CLA.md](CLA.md). Contributors keep the copyright in their work; the CLA gives the project the right to license
contributions under the AGPL and under other licenses, including commercial ones. The signing mechanism (the CLA
Assistant GitHub app) is not set up yet, and outside code contributions are not accepted until it is.

## Future paid features

There are no paid or subscription features today. If any are ever added:

- They will live only in one clearly named top-level directory, under a separate source-available license whose text
  is stored in that directory.
- Every file outside that directory stays `AGPL-3.0-or-later`.
- The plan will be announced publicly before the directory is created.

No such directory exists now.

## Core features stay free

These core features remain free and AGPL-licensed, and will not be moved behind a paid tier or into the
source-available directory:

- the game library;
- launching games;
- local saves and snapshots (export and restore);
- progress tracking.

## Third-party material

- Dependencies are used under their own licenses. Shipped dependencies must be permissive; the policy is in
  [AGENTS.md](AGENTS.md#dependency-and-license-policy).
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) is adapted from the Contributor Covenant 3.0 and stays under
  CC BY-SA 4.0.
- [CLA.md](CLA.md) is adapted from the Harmony HA-CLA-I template (CC BY 3.0).
- Test games used for compatibility checks keep their upstream licenses. Games under copyleft licenses are used only
  as external URLs and are never copied into this repository.

## Trademarks

The AGPL does not grant any right to the project name or logo. See [TRADEMARKS.md](TRADEMARKS.md).
