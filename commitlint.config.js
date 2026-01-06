export default {
    extends: ['@commitlint/cli', '@commitlint/config-conventional'],
    rules: {
        'type-enum': [
            2,
            'always',
            [
                'initial', // For initial commit
                'feat', // Introduces a new feature
                'fix', // Fixes a bug
                'docs', // Documentation changes only
                'style', // Code style changes (e.g., formatting, missing semicolons, etc.)
                'refactor', // Code changes that neither fix a bug nor add a feature
                'perf', // Performance improvements
                'test', // Adding or updating tests
                'build', // Changes to the build system or external dependencies
                'ci', // Changes to CI configuration files/scripts
                'chore', // Other changes that don't modify src or test files
                'revert' // Reverts a previous commit
            ]
        ],
        'subject-case': [2, 'always', 'sentence-case'],
        'type-case': [2, 'always', 'lower-case']
    }
}

// "Initial": Used for initial setup.
// "Feature": For new features.
// "Fix": For bug fixes.
// "Doc": For documentation changes.
// "Scale": For scaling operations.
// "Refactor": For code refactoring.
// "Optimized": For optimizations.
// "Test": For adding or updating tests.
// "Build": For build-related changes.
// "Ci": For CI/CD changes.
// "Chore": For routine tasks like dependency updates.
// "Revert": For reverting previous changes.
