# Simplified CSV Form Template Guide

## Overview

This guide explains how to use the simplified CSV template to create forms with section branching.

**Key Simplifications:**
- ✅ No redundant "Option 1, Option 2, ... Option 20" columns
- ✅ No complex "When Option X selected, go to which section?" columns
- ✅ Simple navigation: `Options` + `Section Navigation` = automatic branching
- ✅ Automatic submit button injection on all navigated sections

## Template Structure

### Required Columns (17 Total)

```
Form Title | Form Description | Section Number | Section Title | Section Description | Section Weightage |
Question | Question Description | Question Type | Required | Options | Option Notes | 
Section Navigation | Follow up Option | Parent Question | Correct Answer | Correct Answers
```

**Note:** The "Follow Up Trigger" column specifies which option value triggers a follow-up question. For non-follow-up rows, leave this column empty.

### Column Definitions

| Column | Description | Example | Required |
|--------|-------------|---------|----------|
| **Form Title** | Name of the form | "Pet Quiz Survey" | ✅ Yes |
| **Form Description** | Overview of the form | "Quick survey about pet preferences" | ✅ Yes |
| **Section Number** | Which section (1, 2, 3...) | 1 | ✅ Yes |
| **Section Title** | Title of this section | "Welcome" | ✅ Yes |
| **Section Description** | What this section covers | "Tell us about your favorite animals" | ❌ Optional |
| **Section Weightage** | Percentage weight of this section (0-100) | 20 | ❌ Optional (must total 100% if used) |
| **Question** | The question text | "Which is your favorite pet?" | ✅ Yes |
| **Question Description** | Additional details | "Choose one animal" | ❌ Optional |
| **Question Type** | Type of question | `radio`, `checkbox`, `text`, `textarea`, `number`, `date`, `boolean`, `grid`, `rating`, `image`, `yesNoNA` | ✅ Yes |
| **Required** | Is this question mandatory? | `TRUE` or `FALSE` | ✅ Yes |
| **Options** | Comma-separated options (for radio/checkbox) | "dog,cat,pig" | ❌ Optional (for radio/checkbox only) |
| **Option Notes** | Notes about the options | "Three common pets" | ❌ Optional |
| **Section Navigation** | Semicolon-separated target section numbers | "2;3;4" | ❌ Optional (only for branching questions) |
| **Follow up Option** | Does this question have follow-ups? | `YES` or `NO` | ❌ Optional |
| **Parent Question** | Text of parent question if this is follow-up | "Which is your favorite pet?" | ❌ Optional (required for follow-up questions) |
| **Follow Up Trigger** | Which option value triggers this follow-up | "dog" | ❌ Optional (required if Parent Question is set) |
| **Correct Answer** | For quiz: correct answer value | "dog" | ❌ Optional |
| **Correct Answers** | For quiz: multiple answers (pipe-separated) | "Loyal\|Friendly" | ❌ Optional |

## Section Weightage (Percentage Distribution)

### What is Section Weightage?

Section weightage allows you to assign importance percentages to different sections of your form. This is useful for:
- **Scoring/Grading:** Different sections contribute different amounts to the final score
- **Analytics:** Understanding which sections are more important
- **Assessment Forms:** Weight theory, practical, and interview sections differently

### How It Works

- **Value Range:** 0-100 (percentage)
- **Total Must Equal 100%:** If any section has weightage > 0, all sections together must total exactly 100%
- **Optional:** You can leave all sections at 0 if you don't need weightage
- **Decimal Values:** Supported (e.g., 33.33 for 3 equal sections)

### CSV Example: Equal Distribution

```csv
Form Title,Form Description,Section Number,Section Title,Section Weightage,Question,Question Type,Required
Exam Form,Final Exam,1,Theory,40,What is photosynthesis?,text,TRUE
Exam Form,Final Exam,1,Theory,40,Explain gravity,paragraph,TRUE
Exam Form,Final Exam,2,Practical,40,Upload your experiment,file,TRUE
Exam Form,Final Exam,3,Viva,20,Tell us about your project,paragraph,TRUE
```

**Result:** Theory (40%) + Practical (40%) + Viva (20%) = 100% ✓

### CSV Example: Unequal Distribution

```csv
Form Title,Section Number,Section Title,Section Weightage,Question,...
Survey,1,Introduction,10,What is your name?,...
Survey,2,Core Questions,50,Rate our service,...
Survey,2,Core Questions,50,Would you recommend us?,...
Survey,3,Additional Feedback,20,Any suggestions?,...
Survey,4,Demographics,20,What is your age?,...
```

**Result:** 10% + 50% + 20% + 20% = 100% ✓

### Validation Rules

✅ **Valid Examples:**
- All sections = 0% (weightage not used)
- 5 sections × 20% = 100%
- 40% + 30% + 20% + 10% = 100%

❌ **Invalid Examples:**
- 30% + 30% + 30% = 90% (doesn't total 100%)
- 25% + 25% + 25% + 25% + 25% = 125% (exceeds 100%)
- One section = 50%, others = 0% (partial weightage not allowed)

### Important Notes

1. **All questions in same section must have same weightage value**
   - Section 1, Question 1: 20%
   - Section 1, Question 2: 20% ← Same section, same weightage

2. **Parser validates total = 100%**
   - Error message: "Section weightage must add up to 100%. Current total: 90%"

3. **Leave blank or set to 0 if not using weightage**
   - No validation error if all sections are 0

## Yes/No/N/A Question Type (Auto-Scoring)

### What is yesNoNA Type?

The `yesNoNA` question type is a special preset type for quick assessment forms:
- **Auto-populated options:** Always has exactly 3 options: `Yes`, `No`, `N/A`
- **No manual entry required:** Just specify `yesNoNA` as the type
- **Automatic scoring:** 
  - ✅ **Yes** = 1 point
  - ❌ **No** = 0 points
  - ❌ **N/A** = 0 points
- **Total marks:** Sum of all "Yes" answers across yesNoNA questions

### CSV Example

```
Form Title,Form Description,Section Number,Section Title,Question,Question Type,Required,Options,Correct Answer
Assessment,Quick assessment,1,Survey,Do you agree with statement 1?,yesNoNA,TRUE,,YES
Assessment,Quick assessment,1,Survey,Do you agree with statement 2?,yesNoNA,TRUE,,YES
Assessment,Quick assessment,1,Survey,Do you agree with statement 3?,yesNoNA,FALSE,,YES
```

**Important Notes:**
- Leave **Options column BLANK** for yesNoNA questions - it's auto-populated!
- **Correct Answer** should be "YES" for scoring context (optional)
- No need to specify "Yes,No,N/A" manually

### Form Submission Result

When the form is submitted:
```json
{
  "score": {
    "correct": 2,  // Number of "Yes" answers
    "total": 3,    // Total yesNoNA questions
    "percentage": 67  // (2/3)*100
  }
}
```

## Follow-up Questions (Option-Wise)

### What are Follow-up Questions?

Follow-up questions appear **inline, immediately below a specific option** when that option is selected by the respondent. They allow you to:
- Ask clarifying questions based on specific answers
- Collect additional details without navigating to separate sections
- Create adaptive surveys that respond to user choices

### When to Use Follow-ups

✅ **Good use cases:**
- "If you selected 'Dog', what breed?"
- "If you chose 'Other', please specify"
- "Rate the above service you mentioned"
- "Tell us more about your experience with..."

❌ **Not for:**
- Completely different questions (use Section Navigation instead)
- Complex branching logic (use Section Navigation)

### CSV Structure for Follow-ups

**Two types of rows needed:**

1. **Parent Question** (normal question row):
   - Write the question normally
   - Leave **Parent Question** column blank
   - Leave **Follow Up Trigger** column blank
   - Set **Follow up Option** to `YES` if it has follow-ups

2. **Follow-up Question** (child question row):
   - Write the follow-up question in "Question" column
   - Set **Parent Question** to the exact text of parent question
   - Set **Follow Up Trigger** to the option value that triggers it
   - Set **Follow up Option** to `YES`
   - ⚠️ Must be in SAME section as parent question

### CSV Examples

#### Example 1: Simple Follow-up

```csv
Form Title,Form Description,Section Number,Section Title,Question,Question Type,Required,Options,Parent Question,Follow Up Trigger,Follow up Option
Pet Survey,Tell us about pets,1,Questions,Do you have pets?,radio,TRUE,"Yes,No",,,,
Pet Survey,Tell us about pets,1,Questions,If yes how many?,number,FALSE,,"Do you have pets?",Yes,YES
Pet Survey,Tell us about pets,1,Questions,What type?,text,FALSE,,"Do you have pets?",Yes,YES
```

**Result:**
- When user selects "Yes" → Shows "If yes how many?" + "What type?" immediately below

#### Example 2: Multiple Options with Different Follow-ups

```csv
Form Title,Form Description,Section Number,Section Title,Question,Question Type,Required,Options,Parent Question,Follow Up Trigger,Follow up Option
Customer Survey,Quick survey,1,Main,Are you satisfied?,radio,TRUE,"Very,Somewhat,Not",,,
Customer Survey,Quick survey,1,Main,What specifically?,text,FALSE,,Are you satisfied?,Very,YES
Customer Survey,Quick survey,1,Main,What should we improve?,text,FALSE,,Are you satisfied?,Not,YES
Customer Survey,Quick survey,1,Main,Any suggestions?,text,FALSE,,Are you satisfied?,Somewhat,YES
```

**Result:**
- "Very" → Shows "What specifically?"
- "Not" → Shows "What should we improve?"
- "Somewhat" → Shows "Any suggestions?"

#### Example 3: Follow-ups with Options (Nested Follow-ups)

```csv
Form Title,Form Description,Section Number,Section Title,Question,Question Type,Required,Options,Parent Question,Follow Up Trigger,Follow up Option
Support,Help form,1,Support,Issue type?,radio,TRUE,"Login,Bug,Feature",,YES,
Support,Help form,1,Support,Can't login how?,text,FALSE,,Issue type?,Login,YES
Support,Help form,1,Support,Which feature?,radio,FALSE,"Search,Export,API",Issue type?,Feature,YES
Support,Help form,1,Support,Already requested?,radio,FALSE,"Yes,No",Which feature?,Export,YES
```

**Result:** Complex follow-up chain:
- Select "Feature" → Shows "Which feature?" options
- Select "Export" → Shows "Already requested?"

### Important Rules

⚠️ **Critical Requirements:**
1. Parent and follow-up must be in the **SAME section**
2. Follow-up question text must match parent question text **EXACTLY** in Parent Question column
3. Trigger value must match an option in parent question **EXACTLY** (case-sensitive)
4. Follow-up questions appear in the form builder UI under parent question
5. Multiple follow-ups for same parent are supported

### Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| "Parent question not found" | Parent Question text doesn't match | Copy exact text from parent question |
| "Trigger option does not exist" | Option name doesn't match parent options | Use exact option name (case-sensitive) |
| "Follow-up not appearing" | Wrong section | Ensure follow-up in same section as parent |

## How Section Navigation Works

### Simple Format - ONLY Section Numbers

The system counts options and maps each to a section number (NO option names, just numbers!):

```
Options: cat,dog,pig
Section Navigation: 8;7;5
```

**Simple positional mapping:**
- cat (option 1) → Section **8** ✓
- dog (option 2) → Section **7** ✓
- pig (option 3) → Section **5** ✓

**That's it! Just numbers separated by semicolons!**

### Important Rules

1. **Count must match**: Number of options = Number of navigation sections
   ```
   ✅ Correct: 3 options → "cat,dog,pig" with "8;7;5"
   ❌ Wrong: 3 options → "cat,dog,pig" with "8;7"  (only 2 sections!)
   ```

2. **All sections must exist**: Every target section must be defined in the CSV
   ```
   ✅ Correct: Section 1, 5, 7, 8 all defined with Navigation "8;7;5"
   ❌ Wrong: Sections 1-4 defined but Navigation "8;7;5" references sections 5,7,8
   ```

3. **MANDATORY: Submit buttons on ALL navigated sections**
   ```
   If Navigation is "8;7;5", then sections 8, 7, and 5 MUST have submit buttons
   This is automatic - you don't add submit buttons, the system does it!
   ```

## Example CSV

### Simple Radio Question with Branching - Numbers Only!

```
Form Title,Form Description,Section Number,Section Title,Section Description,Question,Question Description,Question Type,Required,Options,Option Notes,Section Navigation,Follow up Option,Parent Question,Correct Answer,Correct Answers
Pet Quiz,Pet preference survey,1,Welcome,Tell us about pets,Which is your favorite?,Choose one,radio,TRUE,"cat,dog,pig",Your choice,8;7;5,NO,,cat,
Pet Quiz,Pet preference survey,5,Pig Section,For pig lovers,Seen a farm?,Yes or no,boolean,TRUE,,,,NO,,YES,
Pet Quiz,Pet preference survey,7,Dog Section,For dog lovers,Do you have a dog?,Yes or no,boolean,FALSE,,,,NO,,,
Pet Quiz,Pet preference survey,8,Cat Section,For cat lovers,Cat breed?,Single choice,radio,FALSE,"Siamese,Persian,Tabby",Breeds,,NO,,,
```

**Mapping (JUST NUMBERS!):**
- cat → section **8** [SUBMIT ✓]
- dog → section **7** [SUBMIT ✓]
- pig → section **5** [SUBMIT ✓]

### Complex Example with Quiz Answers

```
Form Title,Form Description,Section Number,Section Title,Section Description,Question,Question Description,Question Type,Required,Options,Option Notes,Section Navigation,Follow up Option,Parent Question,Correct Answer,Correct Answers
Quiz,Knowledge test,1,Math,Math questions,2+2=?,Choose answer,radio,TRUE,"2,3,4,5",Basic math,2;2;2;2,NO,,4,
Quiz,Knowledge test,2,Result,Show results,Your answer was correct!,Multiple choice,checkbox,FALSE,"Correct,Good Job",Results,,NO,,,Correct|Good Job
```

## API Endpoint

### Upload CSV to Create Form

**Endpoint:** `POST /api/forms/import/csv`

**Headers:**
```
Authorization: Bearer {token}
Content-Type: multipart/form-data
```

**Body:**
```
{
  "file": <CSV file>,
  "tenantId": "{tenantId}" (only required for superadmin)
}
```

**Example cURL:**
```bash
curl -X POST http://localhost:3000/api/forms/import/csv \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@FormTemplateSimplified.csv"
```

**Response:**
```json
{
  "success": true,
  "message": "Form imported successfully from CSV",
  "data": {
    "form": {
      "id": "uuid",
      "title": "Pet Quiz Survey",
      "description": "Quick survey about pet preferences",
      "sections": [...],
      "sectionBranching": [...]
    }
  }
}
```

## Error Handling

### Validation Errors

The system validates:
1. All required columns are present
2. Section numbers are valid integers
3. Required fields are not empty
4. Options and Section Navigation counts match
5. All target sections exist
6. No duplicate options per question

**Example Error Response:**
```json
{
  "success": false,
  "message": "CSV Parse Error: Section Navigation count (2) must match Options count (3)",
  "issues": [...]
}
```

## CSV Best Practices

### ✅ DO:
- Keep form titles concise and descriptive
- Use lowercase for question types: `radio`, `checkbox`, `text`
- Use `TRUE`/`FALSE` in caps for boolean fields
- Separate options with commas: `dog,cat,pig`
- Separate section navigation with semicolons: `2;3;4`
- Keep all rows for the same form together (don't interleave)
- Use consistent formatting

### ❌ DON'T:
- Leave required columns blank (Form Title, Section Number, Question, Question Type, Required)
- Mix option separators (comma vs semicolon vs pipe)
- Create gaps in section numbers (sections 1, 3, 5 - skip 2, 4)
- Use trailing/leading spaces in options: Use `dog,cat,pig` not `dog, cat, pig`
- Add navigation without matching options
- Create circular branching (Section 2 → Section 3 → Section 2)

## Template Files Location

- **Simple Template:** `backend/scripts/FormTemplateSimplified.csv`
- **Parser Utility:** `backend/utils/csvFormParser.js`
- **Import Endpoint:** `POST /api/forms/import/csv`

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "CSV must have header and at least one data row" | Ensure first row is headers, at least 2 rows total |
| "Missing required header: X" | Add the missing column to first row |
| "Section Navigation count must match Options count" | Make sure `Options` and `Section Navigation` have same count |
| "Invalid section number in navigation" | All section numbers must be valid integers |
| "referenced non-existent section" | Define all sections referenced in navigation |
| "No CSV file provided" | Make sure file is attached in multipart request |

## Next Steps

1. Download the template from `FormTemplateSimplified.csv`
2. Fill in your form data following the guidelines
3. Upload via the API or UI
4. Test the branching logic
5. Publish the form

---

**Questions?** Check the example file or test with the sample data provided.