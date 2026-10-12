import { v4 as uuidv4 } from 'uuid';

/**
 * Map question type names from CSV/UI to backend enum values
 * Handles case-insensitive input and human-readable names with spaces/slashes
 */
const mapQuestionType = (csvType) => {
  if (!csvType) return csvType;
  
  // Normalize: lowercase, trim, remove extra spaces, replace slashes with nothing
  let normalizedType = String(csvType)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ') // normalize multiple spaces to single space
    .replace(/\s*\/\s*/g, ''); // remove slashes and surrounding spaces
  
  const typeMap = {
    // Legacy/UI type names - without spaces/slashes
    'shorttext': 'text',
    'shortint': 'text',
    'multiplechoice': 'radio',
    'longtext': 'paragraph',
    'longinput': 'paragraph',
    'dropdown': 'select',
    'checkboxes': 'checkbox',
    'fileupload': 'file',
    'file upload': 'file',
    
    // Yes/No variations
    'yesnona': 'yesNoNA',
    'yesno': 'yesNoNA',  // Yes/No → yesNoNA
    'yesnona': 'yesNoNA',  // Yes / No / N/A → yesNoNA
    
    // Core types - pass through
    'text': 'text',
    'radio': 'radio',
    'paragraph': 'paragraph',
    'select': 'select',
    'checkbox': 'checkbox',
    'yesNoNA': 'yesNoNA',
    
    // Extended types - supported by schema
    'email': 'email',
    'url': 'url',
    'tel': 'tel',
    'date': 'date',
    'time': 'time',
    'file': 'file',
    'range': 'range',
    'rating': 'rating',
    'scale': 'scale',
    'radio-grid': 'radio-grid',
    'radiogrid': 'radio-grid',
    'checkbox-grid': 'checkbox-grid',
    'checkboxgrid': 'checkbox-grid',
    'radio-image': 'radio-image',
    'radioimage': 'radio-image',
    'search-select': 'search-select',
    'searchselect': 'search-select',
    'slider-feedback': 'slider-feedback',
    'sliderfeedback': 'slider-feedback',
    'emoji-star-feedback': 'emoji-star-feedback',
    'emojistarfeedback': 'emoji-star-feedback',
    'emoji-reaction-feedback': 'emoji-reaction-feedback',
    'emojireactionfeedback': 'emoji-reaction-feedback',
    'number': 'number',
    'location': 'location',
    'textarea': 'textarea',
    'chassis-with-zone': 'chassis-with-zone',
    'chassiswithzone': 'chassis-with-zone',
    'chassis-without-zone': 'chassis-without-zone',
    'chassiswithoutzone': 'chassis-without-zone',
    'zone-in': 'zone-in',
    'zonein': 'zone-in',
    'zone-out': 'zone-out',
    'zoneout': 'zone-out'
  };
  
  // First try exact match after normalization
  if (typeMap[normalizedType]) {
    return typeMap[normalizedType];
  }
  
  // If not found, try with spaces removed entirely
  const noSpaces = normalizedType.replace(/\s/g, '');
  if (typeMap[noSpaces]) {
    return typeMap[noSpaces];
  }
  
  return csvType; // Return original if no match found
};

/**
 * Parse simplified CSV template format
 * Format: Options (comma-separated) → Section Navigation (semicolon-separated section numbers)
 * Example: "dog,cat,pig" with navigation "2;3;4" means:
 *   - Option 1 (dog) → go to section 2
 *   - Option 2 (cat) → go to section 3
 *   - Option 3 (pig) → go to section 4
 */
export const parseSimplifiedCSVForm = (csvData, formMetadata = {}) => {
  try {
    const lines = csvData.trim().split('\n');
    if (lines.length < 2) {
      throw new Error('CSV must have header and at least one data row');
    }

    const headers = lines[0].split(',').map(h => h.trim());
    const headerMap = {};
    headers.forEach((h, i) => {
      headerMap[h] = i;
    });

    // Validate required headers
    const requiredHeaders = [
      'Form Title', 'Form Description', 'Section Number', 'Section Title',
      'Question', 'Question Type', 'Required', 'Options'
    ];
    
    for (const header of requiredHeaders) {
      if (!(header in headerMap)) {
        throw new Error(`Missing required header: ${header}`);
      }
    }

    // Parse data rows
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // Simple CSV parser (handles quoted values)
      const row = parseCSVLine(line);
      const rowObj = {};
      headers.forEach((h, idx) => {
        rowObj[h] = row[idx] ? row[idx].trim() : '';
      });
      rows.push(rowObj);
    }

    if (rows.length === 0) {
      throw new Error('No data rows found in CSV');
    }

    // Get form-level metadata from first row
    const formTitle = rows[0]['Form Title'];
    const formDescription = rows[0]['Form Description'];

    if (!formTitle || !formDescription) {
      throw new Error('Form Title and Description are required');
    }

    // Group questions by section
    const sectionMap = new Map();
    const branchingRules = [];
    const questionMap = new Map(); // Map question text to ID for linking follow-ups
    const followUpQuestions = []; // Collect follow-up questions for processing after main questions

    // Track all parameters for returning in preview
    const allParameters = new Set();

    rows.forEach((row, rowIndex) => {
      const sectionNum = parseInt(row['Section Number']);
      const sectionTitle = row['Section Title'];
      const sectionDesc = row['Section Description'] || '';
      const sectionWeightage = row['Section Weightage'] ? parseFloat(row['Section Weightage']) : 0;
      const nextSectionNum = row['Next Section'] || '';
      const question = row['Question'];
      const questionDesc = row['Question Description'] || '';
      const questionType = row['Question Type'];
      const required = row['Required'].toUpperCase() === 'TRUE';
      const optionsStr = row['Options'];
      const sectionNavStr = row['Section Navigation'];
      const correctAnswer = row['Correct Answer'] || '';
      const correctAnswers = row['Correct Answers'] || '';
      const followUpOption = row['Follow up Option'] ? row['Follow up Option'].toUpperCase() === 'YES' : false;
      const parentQuestion = row['Parent Question'] || '';
      const followUpTrigger = row['Follow Up Trigger'] || ''; // Which option triggers this follow-up
      const mainParameter = row['Main Parameter'] || row['Main Parameters'] || row['SubParam1'] || row['Sub Parameter 1'] || ''; // Main parameter name
      const followupParameter = row['Followup Parameter'] || row['Followup Parameters'] || row['Follow up Parameter'] || row['Follow up Parameters'] || row['SubParam2'] || row['Sub Parameter 2'] || ''; // Followup parameter name

      if (!sectionNum || !question || !questionType) {
        throw new Error(`Row ${rowIndex + 2}: Missing Section Number, Question, or Question Type`);
      }

      const sectionId = `section-${sectionNum}`;
      const questionId = `question-${uuidv4()}`;

      // Initialize section if not exists
      if (!sectionMap.has(sectionId)) {
        sectionMap.set(sectionId, {
          id: sectionId,
          title: sectionTitle,
          description: sectionDesc,
          weightage: sectionWeightage,
          nextSectionId: nextSectionNum && nextSectionNum.toLowerCase() !== 'end' ? `section-${nextSectionNum}` : (nextSectionNum.toLowerCase() === 'end' ? 'end' : null),
          number: sectionNum,
          questions: []
        });
      }

      // Parse options - auto-populate for yesNoNA type
      let options = [];
      const mappedType = mapQuestionType(questionType);
      if (mappedType === 'yesNoNA') {
        // Auto-populate Yes/No/N/A options
        options = ['Yes', 'No', 'N/A'];
      } else {
        options = optionsStr
          ? optionsStr.split(',').map(o => o.trim()).filter(o => o)
          : [];
      }

      // Build question object
      const questionObj = {
        id: questionId,
        text: question,
        description: questionDesc,
        type: mapQuestionType(questionType),
        required: required,
        options: options,
        sectionId: sectionId,
        followUpQuestions: [],
        followUpConfig: {}
      };

      // Add parameters if present
      if (mainParameter) {
        questionObj.subParam1 = mainParameter;
        allParameters.add({ name: mainParameter, type: 'main' });
      }
      if (followupParameter) {
        questionObj.subParam2 = followupParameter;
        allParameters.add({ name: followupParameter, type: 'followup' });
      }

      // Initialize followUpConfig for options
      if (options.length > 0) {
        options.forEach(option => {
          questionObj.followUpConfig[option] = { hasFollowUp: false, required: false };
        });
      }

      // Add correct answer info if present
      if (correctAnswer) {
        questionObj.correctAnswer = correctAnswer;
      }
      if (correctAnswers) {
        questionObj.correctAnswers = correctAnswers.split('|').map(a => a.trim());
      }

      // Check if this is a follow-up question (has parent question reference)
      if (parentQuestion) {
        // This is a follow-up question - store for processing later
        followUpQuestions.push({
          row: rowIndex + 2,
          parentQuestionText: parentQuestion,
          question: questionObj,
          triggerOption: followUpTrigger
        });
      } else {
        // This is a regular question
        // Store question ID for potential follow-up linking
        questionMap.set(question, { id: questionId, sectionId: sectionId, object: questionObj });

        // Parse section navigation and create branching rules
        if (sectionNavStr && options.length > 0) {
          const targetSections = sectionNavStr.split(';').map(s => s.trim());
          
          if (targetSections.length !== options.length) {
            throw new Error(
              `Row ${rowIndex + 2}: Section Navigation count (${targetSections.length}) ` +
              `must match Options count (${options.length})`
            );
          }

          // Create branching rule for each option
          options.forEach((optionLabel, optionIndex) => {
            const targetSectionNum = parseInt(targetSections[optionIndex]);
            
            if (isNaN(targetSectionNum)) {
              throw new Error(
                `Row ${rowIndex + 2}: Invalid section number in navigation: ${targetSections[optionIndex]}`
              );
            }

            branchingRules.push({
              questionId: questionId,
              sectionId: sectionId,
              optionLabel: optionLabel,
              optionIndex: optionIndex,
              targetSectionId: `section-${targetSectionNum}`,
              isOtherOption: false
            });
          });
        }

        sectionMap.get(sectionId).questions.push(questionObj);
      }
    });

    // Process follow-up questions and link them to parent questions
    followUpQuestions.forEach(followUp => {
      const parentData = questionMap.get(followUp.parentQuestionText);
      
      if (!parentData) {
        throw new Error(
          `Row ${followUp.row}: Parent question "${followUp.parentQuestionText}" not found`
        );
      }

      if (!followUp.triggerOption) {
        throw new Error(
          `Row ${followUp.row}: Follow-up question must specify "Follow Up Trigger" (which option triggers it)`
        );
      }

      // Check if trigger option exists in parent question
      if (!parentData.object.options || !parentData.object.options.includes(followUp.triggerOption)) {
        throw new Error(
          `Row ${followUp.row}: Trigger option "${followUp.triggerOption}" does not exist in parent question "${followUp.parentQuestionText}"`
        );
      }

      // Add showWhen property to the follow-up question (marks it as a follow-up)
      followUp.question.parentId = parentData.id;
      followUp.question.showWhen = {
        questionId: parentData.id,
        value: followUp.triggerOption
      };

      // Add follow-up as a FLAT question in the same section (NOT nested)
      sectionMap.get(parentData.sectionId).questions.push(followUp.question);
      
      // Also track it in the parent's followUpConfig for UI display
      parentData.object.followUpQuestions = parentData.object.followUpQuestions || [];
      parentData.object.followUpQuestions.push(followUp.question);
      parentData.object.followUpConfig[followUp.triggerOption].hasFollowUp = true;
    });

    // Convert sections map to array and sort by number
    const sections = Array.from(sectionMap.values())
      .sort((a, b) => a.number - b.number)
      .map(({ number, ...rest }) => rest);

    // Validate section weightage (if provided, should add up to 100)
    const totalWeightage = sections.reduce((sum, section) => sum + (section.weightage || 0), 0);
    if (totalWeightage > 0 && Math.abs(totalWeightage - 100) > 0.01) {
      throw new Error(
        `Section weightage must add up to 100%. Current total: ${totalWeightage.toFixed(2)}%`
      );
    }

    // Validate that all target sections exist
    const sectionIds = new Set(sections.map(s => s.id));
    
    sections.forEach(section => {
      if (section.nextSectionId && section.nextSectionId !== 'end' && !sectionIds.has(section.nextSectionId)) {
        throw new Error(
          `Next Section references non-existent section: ${section.nextSectionId} in section ${section.id}`
        );
      }
    });

    branchingRules.forEach(rule => {
      if (!sectionIds.has(rule.targetSectionId)) {
        throw new Error(
          `Section Navigation references non-existent section: ${rule.targetSectionId}`
        );
      }
    });

    // Collect all target section IDs from branching rules and section navigation
    const targetSectionIds = new Set();
    branchingRules.forEach(rule => {
      targetSectionIds.add(rule.targetSectionId);
    });
    sections.forEach(section => {
      if (section.nextSectionId && section.nextSectionId !== 'end') {
        targetSectionIds.add(section.nextSectionId);
      }
    });

    // Add submit button to:
    // 1. Last section (always)
    // 2. ALL sections that are targets of branching navigation (mandatory!)
    // 3. Sections that point to 'end'
    if (sections.length > 0) {
      sections[sections.length - 1].showSubmitButton = true;
    }
    
    // Add submit button to all navigated sections (mandatory requirement!)
    sections.forEach(section => {
      if (targetSectionIds.has(section.id) || section.nextSectionId === 'end') {
        section.showSubmitButton = true;
      }
    });

    // Build the form object
    const form = {
      title: formTitle,
      description: formDescription,
      sections: sections,
      sectionBranching: branchingRules,
      parameters: Array.from(allParameters), // Include parameters in form data
      ...formMetadata
    };

    return form;

  } catch (error) {
    throw new Error(`CSV Parse Error: ${error.message}`);
  }
};

/**
 * Simple CSV line parser that handles quoted values
 */
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let insideQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        current += '"';
        i++; // Skip next quote
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (char === ',' && !insideQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  result.push(current);
  return result;
}

/**
 * Validate that all sections have submit buttons for navigated sections
 */
export const validateSubmitButtons = (form) => {
  const navigatedSections = new Set();
  
  form.sectionBranching?.forEach(rule => {
    navigatedSections.add(rule.targetSectionId);
  });

  const issues = [];
  
  form.sections?.forEach(section => {
    if (navigatedSections.has(section.id) && !section.showSubmitButton) {
      issues.push(`Section "${section.title}" (${section.id}) is targeted by branching but has no submit button`);
    }
  });

  return {
    valid: issues.length === 0,
    issues: issues
  };
};