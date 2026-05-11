# Attribution

This project's battle simulation engine and game data are derived from [PvPoke](https://github.com/pvpoke/pvpoke), licensed under the MIT License. Without PvPoke's open-source work this tool would not exist. Many thanks to the PvPoke maintainers and contributors.

The accuracy of this tool's battle ratings is verified against PvPoke's matrix output (100% match across tested matchups in Great League, Ultra League, and Master League).

## What is from PvPoke

- The 7 source files in `js/pvpoke/` (Battle.js, Pokemon.js, ActionLogic.js, DamageCalculator.js, TimelineAction.js, TimelineEvent.js, DecisionOption.js) are copied verbatim from PvPoke.
- All game data files (`gamemaster_cache.json`, `data/gamemaster-data.js`, `data/groups/*.json`, `data/meta-groups.js`, `data/ranking-movesets.js`, `data/ranking-scores.js`, `data/archived-cups.js`) are sourced from PvPoke's public data.

See `CLAUDE.md` for technical details about how PvPoke's code is integrated into this project.

## License

PvPoke is licensed under the MIT License: https://github.com/pvpoke/pvpoke/blob/master/LICENSE

The MIT license and copyright notices are retained at the top of each verbatim file in `js/pvpoke/`. Per MIT terms, this project is permitted to use, modify, and distribute PvPoke's code provided that the original copyright and license notices are preserved.
