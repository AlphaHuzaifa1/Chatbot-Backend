export const exampleTest = () => {
  const result = 1 + 1;
  if (result !== 2) {
    throw new Error('Test failed: 1 + 1 should equal 2');
  }
  console.log('Example test passed');
};

