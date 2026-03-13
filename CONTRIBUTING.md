# Contributing to AI Contribution Tracker

We welcome contributions to AI Contribution Tracker! This document provides guidelines for contributing to the project.

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally
3. **Create a feature branch** for your changes
4. **Make your changes** following our guidelines
5. **Test your changes** thoroughly
6. **Submit a pull request** with a clear description

## Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/ai-contribute.git
cd ai-contribute

# Install dependencies
npm install

# Build the project
npm run build

# Test your changes
npm run dev -- . -v
```

## Code Style Guidelines

### TypeScript Configuration
- Target: ES2022
- Module: NodeNext (strict mode enabled)
- Always use `.js` extension in local imports

### Import Conventions
```typescript
// Node.js built-ins - use namespace import
import * as fs from 'fs';
import * as path from 'path';

// npm packages - direct import
import { Command } from 'commander';
import chalk from 'chalk';

// Local files - MUST include .js extension
import { BaseScanner } from './base.js';
import { AISession } from '../types.js';
```

### Naming Conventions
- **Classes/Interfaces/Enums**: PascalCase (e.g., `BaseScanner`, `FileChange`)
- **Methods/Variables**: camelCase (e.g., `parseSessionFile`, `storagePath`)
- **Enum members**: PascalCase keys with lowercase string values

### Type Annotations
- Always specify return types on public methods
- Use explicit parameter types
- Prefer interfaces for object shapes
- Use `Map<K, V>` for key-value collections

## Types of Contributions

### 🐛 Bug Fixes
- Report bugs via GitHub Issues
- Include steps to reproduce
- Provide example data when possible
- Test with multiple AI tools

### ✨ New Features
- Discuss major changes in Issues first
- Follow existing patterns and conventions
- Add appropriate tests
- Update documentation

### 🔧 AI Tool Support
- See [Tool Integration Guide](docs/tool-integration.md)
- Test with real tool data
- Follow scanner implementation patterns
- Add comprehensive error handling

### 📚 Documentation
- Fix typos and clarify explanations
- Add examples and use cases
- Update API documentation
- Improve translation accuracy

## Testing Your Changes

### Manual Testing Checklist
- [ ] Test with each supported AI tool
- [ ] Verify all output formats (console, JSON, markdown)
- [ ] Test with different verification modes
- [ ] Check edge cases (empty files, large files, binary files)
- [ ] Test cross-platform compatibility

### Test Commands
```bash
# Test basic functionality
npm run dev -- . -v

# Test specific tools
npm run dev -- . -t claude,cursor

# Test different formats
npm run dev -- . -f json -o test.json
npm run dev -- . -f markdown -o test.md

# Test verification modes
npm run dev -- . --verification strict
npm run dev -- . --verification historical
```

## Pull Request Process

### Before Submitting
1. **Build successfully**: `npm run build`
2. **Test thoroughly**: Run manual testing checklist
3. **Update documentation**: Add/update relevant docs
4. **Follow code style**: Adhere to project conventions

### PR Description Template
```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Documentation update
- [ ] AI tool support

## Testing
- [ ] Manual testing completed
- [ ] All output formats tested
- [ ] Cross-platform compatibility checked

## Screenshots/Output
Include relevant output examples if applicable

## Related Issues
Closes #issue_number
```

### Review Process
1. **Automated checks** must pass
2. **Code review** by maintainers
3. **Testing verification** may be requested
4. **Documentation review** for completeness

## Development Guidelines

### Error Handling
```typescript
// Good: Graceful error handling
try {
  const result = await riskyOperation();
  return result;
} catch (error) {
  console.warn('Operation failed:', error.message);
  return []; // Return safe default
}
```

### Performance Considerations
- Use streaming for large files
- Implement incremental parsing
- Cache file system operations
- Consider memory usage with large datasets

### Security Guidelines
- Never log sensitive information
- Validate file paths to prevent directory traversal
- Use safe JSON parsing with error handling
- Follow Node.js security best practices

## Community Guidelines

### Code of Conduct
- Be respectful and inclusive
- Welcome newcomers
- Provide constructive feedback
- Focus on the code, not the person

### Communication
- Use GitHub Issues for bug reports and feature requests
- Join discussions in existing issues
- Ask questions if unclear about requirements
- Provide helpful context in discussions

## Release Process

Releases are managed by maintainers:
1. Version bump following semver
2. Build and test verification
3. Changelog update
4. GitHub release creation
5. npm package publication

## Getting Help

- **GitHub Issues**: Bug reports and feature requests
- **Documentation**: Check [docs/](docs/) directory
- **Examples**: Look at existing implementations
- **Community**: Join discussions in issues

Thank you for contributing to AI Contribution Tracker! 🚀