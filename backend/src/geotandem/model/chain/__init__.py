"""The tool chain of Modus B (*Werkzeugkette*, plan E2.3-E2.6, E2.5).

- ``tools``: the chain's tools as the model meets them: an earlier step is
  named by its position; the tool list of the prompt (P4, structured output).
- ``plan``: a planned step list checked and composed into query objects, one
  per step, the last one the chain's result (F-5.7).
- ``view``: ``model_view``, the only way a step's result reaches the model (D9, D10).
- ``run``: a step run as a count and stamp, never as rows; the re-plan input.

Kept free of imports here, so ``model.prompt`` can import ``tools``.
"""
