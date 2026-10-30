# Exit survey

Answer from your role, about the workflow and its instructions. A defect in the code or text your task judged
belongs in an answer only as far as question 4 needs it, to say what in the workflow caught it or would have
caught it sooner. Answer every question in the order below, and write "none" where you have nothing. Cite
evidence, such as the instruction text you quote or the command you ran and its output.

## Questions

1. Which instruction was unclear, contradictory or missing? Quote it.
2. Which command, tool or file failed, or was not where you were told?
3. What effort did the instructions make you spend that changed nothing?
4. What defect did you catch or nearly miss, and what would have caught it sooner?
5. What worked well and should stay?
6. What one change would most help your role?

## Answer format

Append one section to the answer file your prompt names, and create the file and its folder when they
do not exist. Keep every section already in the file. The section is a heading line, then one line per
question:

```
## <label> <date>
Q1: <answer>
Q2: <answer>
Q3: <answer>
Q4: <answer>
Q5: <answer>
Q6: <answer>
```

`<label>` is the answer file's name without `.md`. `<date>` is the output of the `date` command, run
when you write the section. Each answer stays on its one line. `tools/survey.mjs` reads this format.
