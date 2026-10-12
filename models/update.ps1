$content = Get-Content File.js -Raw  
$updated = $content -replace '(?s)  size: \{\s*type: Number,\s*required: true\s*\},\s*path: \{\s*type: String,\s*required: true\s*\},', @'  
'  size: {'  
'    type: Number,'  
'    required: true'  
'  },'  
'  data: {'  
'    type: Buffer,'  
'    required: true'  
'  },'  
'  path: {'  
'    type: String,'  
'    default: null'  
'  },'  
'@  
$updated | Set-Content File.js  
