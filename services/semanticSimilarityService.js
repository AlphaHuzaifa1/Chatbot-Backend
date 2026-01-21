const ENABLE_LOGGING = process.env.ENABLE_LOGGING !== 'false';

/**
 * Synonym maps for semantic similarity
 */
const SYNONYMS = {
  urgency: ['urgency', 'priority', 'severity', 'how urgent', 'how important', 'how quickly'],
  affectedSystem: ['affected system', 'system', 'application', 'app', 'which system', 'what system'],
  issue: ['issue', 'problem', 'what\'s wrong', 'what is happening', 'describe'],
  category: ['category', 'type', 'kind', 'what type', 'which category'],
  errorText: ['error', 'error message', 'error text', 'what error', 'error code']
};

/**
 * Normalize question text for comparison
 */
const normalizeQuestion = (question) => {
  if (!question) return '';
  
  return question
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, ' ') // Remove punctuation
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
};

/**
 * Simple word-based similarity (no vector DB needed)
 * Uses Jaccard similarity on word sets
 */
const calculateSimilarity = (q1, q2) => {
  const words1 = new Set(normalizeQuestion(q1).split(' ').filter(w => w.length > 2));
  const words2 = new Set(normalizeQuestion(q2).split(' ').filter(w => w.length > 2));
  
  if (words1.size === 0 && words2.size === 0) return 1.0;
  if (words1.size === 0 || words2.size === 0) return 0.0;
  
  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);
  
  return intersection.size / union.size;
};

/**
 * Check if question is semantically similar to any asked question
 * @param {string} question - Question to check
 * @param {Array} askedQuestions - Previously asked questions
 * @param {number} threshold - Similarity threshold (default 0.6)
 * @returns {boolean} True if similar question was already asked
 */
export const isSimilarQuestion = (question, askedQuestions = [], threshold = 0.6) => {
  if (!question || !askedQuestions || askedQuestions.length === 0) {
    return false;
  }
  
  const normalizedNew = normalizeQuestion(question);
  
  for (const askedQ of askedQuestions) {
    const normalizedAsked = normalizeQuestion(askedQ);
    
    // Exact match (after normalization)
    if (normalizedNew === normalizedAsked) {
      return true;
    }
    
    // Calculate similarity
    const similarity = calculateSimilarity(question, askedQ);
    
    if (similarity >= threshold) {
      if (ENABLE_LOGGING) {
        console.log('[Semantic] Similar question detected:', {
          new: question,
          asked: askedQ,
          similarity: similarity.toFixed(2)
        });
      }
      return true;
    }
  }
  
  return false;
};

/**
 * Find similar question from list
 * @param {string} question - Question to check
 * @param {Array} askedQuestions - Previously asked questions
 * @param {number} threshold - Similarity threshold
 * @returns {string|null} Similar question if found, null otherwise
 */
export const findSimilarQuestion = (question, askedQuestions = [], threshold = 0.6) => {
  if (!question || !askedQuestions || askedQuestions.length === 0) {
    return null;
  }
  
  for (const askedQ of askedQuestions) {
    const similarity = calculateSimilarity(question, askedQ);
    if (similarity >= threshold) {
      return askedQ;
    }
  }
  
  return null;
};

export default {
  isSimilarQuestion,
  findSimilarQuestion
};

