# Baseline evaluation

`validator.py` receives a proposed operation sequence, the same bank snapshot, hard rules, and policy as the Parlance comparison. It reuses C1 operation simulation and C2 policy and constraint evaluation at every step. It checks each action locally and cumulatively. It does not synthesize an alternative or check whether an individually valid intermediate action preserves the approved final goal.

The comparison runner is `evaluation/compiler/run.py`. Its per-scenario outputs are `evaluation/results/baseline-results.json` and `comparison-results.json`.
