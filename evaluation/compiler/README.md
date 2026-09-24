# Compiler evaluation

Run `python3 evaluation/compiler/run.py` from the repository root. `scenarios.py` declares expected outcomes and builds isolated inputs from shared contract fixtures. The runner measures C3 planning, C4 preflight and preservation, C5 revalidation, replanning and relaxation, and C6 opportunity facts. It exits nonzero on an incorrect case, adversarial result, comparison, or determinism check.

Generated results are in `evaluation/results/`; see `evaluation/REPORT.md`. Correctness JSON excludes variable timing data, which is in `performance-results.json`.
