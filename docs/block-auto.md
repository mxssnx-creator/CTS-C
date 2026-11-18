# Block Auto

Strategy Lab → Block allocation offers independent automatic evaluation of each increase. Manual Block is the default. The optional policy has a 30-observation recent window, a 15-observation minimum and a 1.10 net return PF floor. A policy change starts a separate cohort for the affected Block settings.

- Pyramid mode records each favorable-move trigger, including a held trigger. At the modeled parent exit, it scores that trigger's return after the captured position cost. The engine holds deeper adds until every earlier add in that position has executed. Shared mode uses its existing base and add budgets.
- Rounds mode records the requested increase level when the parent opens. A warming, losing or unknown level uses the base budget. Settlement scores that level's own unit return once. Round size, level cap, cumulative recovery and pause operate on their existing per-lane state.
- Each sample belongs to its exact symbol, direction, configuration, stage and policy. Mirrored Live positions follow the associated Real allocation or fill. They do not maintain a second decision book.

Run the matched offline comparison on recorded closed candles with the existing fixture format.

```sh
node --import tsx scripts/replay-config-stage-windows.ts feed.json results.json --block-auto
```

The comparison runs manual and automatic Shared and Additive pyramid arms and 3- and 6-position round arms. It records settled modeled return PF, cash PF, realized drawdown, hourly Block closes and the ending Real evidence by count. It also asserts that changing the Block arm leaves the Normal, Axis and DCA summaries identical on the same input.

## Recorded comparison

Four eight-symbol windows use 12 hours of prehistory, 12 hours of measured bars and 0.11% modeled round-trip cost. The automatic arms use 12 recent observations, a three-observation minimum and PF 1.10. Both Shared pyramid Auto and six-position rounds Auto had return and cash PF above 1 in two windows. On October 13, Shared pyramid Auto settled 717 positions at return PF 1.440 and cash PF 1.507. Realized drawdown in that arm was 0.281 units, compared with 0.427 for the matched manual policy. The same Auto arm lost money on October 9 and 15. This study keeps automatic increases optional and submitted zero orders.
