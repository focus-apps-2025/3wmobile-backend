import * as XLSX from "xlsx-js-style";
const { utils } = XLSX;

// Simple mock form
const form = {
  title: "Chassis N603",
  chassisNumbers: ["iuoiuoeiouiou"],
  sections: [
    {
      title: "Basic Info",
      questions: [
        { id: "chassis_id", text: "Chassis Number", type: "text", required: true },
        { id: "rust_id", text: "Rust", type: "zone-out", required: true },
        { id: "burr_id", text: "Burr / Sharp edges", type: "zone-out", required: true }
      ]
    }
  ]
};

// 1. Flatten all questions
const allQuestions = [];
form.sections.forEach((section) => {
  section.questions.forEach((q) => {
    allQuestions.push(q);
  });
});

// 2. Create Header Rows dynamically
const columns = [];

// Add mandatory Submitted Date column
columns.push({
  label: "Submitted Date *",
  id: "submittedAt",
  type: "date",
  required: true,
});

// Add Selected Chassis column if form has chassis numbers configured
if (form.chassisNumbers && form.chassisNumbers.length > 0) {
  const chassisOptions = form.chassisNumbers.map((cn) =>
    typeof cn === "string" ? cn : cn.chassisNumber
  );
  columns.push({
    label: "Selected Chassis",
    id: "chassis_number",
    type: "select",
    options: chassisOptions,
    required: false,
  });
}

const headerCounts = {};
allQuestions.forEach((q) => {
  let headerText = q.text || `Untitled Question (ID: ${q.id})`;
  
  if (headerCounts[headerText]) {
    headerCounts[headerText]++;
    headerText = `${headerText} (${headerCounts[headerText]})`;
  } else {
    headerCounts[headerText] = 1;
  }
  
  columns.push({
    label: headerText,
    id: q.id,
    type: q.type,
    options: q.options,
    required: q.required,
  });
});

const visibleHeader = columns.map((col) => col.label);
const idHeader = columns.map((col) => col.id);
const data = [visibleHeader, idHeader];

// 3. Create worksheet
const worksheet = utils.aoa_to_sheet(data);

// 4. Add comments
columns.forEach((col, index) => {
  const cellRef = utils.encode_cell({ r: 0, c: index });
  const commentLines = [];
  if (col.type) {
    commentLines.push(`Type: ${col.type}`);
  }
  if (col.options && col.options.length > 0) {
    commentLines.push(`Options: ${col.options.join(", ")}`);
  }
  if (col.required) {
    commentLines.push("Required: YES");
  }
  
  if (worksheet[cellRef] && commentLines.length > 0) {
    worksheet[cellRef].c = [{ a: 'System', t: commentLines.join("\n") }];
  }
});

// Print cell keys and their values and comments
console.log('Worksheet Cell Details:');
columns.forEach((col, index) => {
  const cellRef = utils.encode_cell({ r: 0, c: index });
  const cell = worksheet[cellRef];
  console.log(`Cell ${cellRef} (${col.label}):`);
  console.log(`  Value: ${cell ? cell.v : 'undefined'}`);
  console.log(`  Comment: ${cell && cell.c ? JSON.stringify(cell.c) : 'none'}`);
});
