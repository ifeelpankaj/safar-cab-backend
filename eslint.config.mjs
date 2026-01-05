import js from '@eslint/js'
import globals from 'globals'
import eslintConfigPrettier from 'eslint-config-prettier'

export default [
    {
        ignores: ['dist', 'build', 'coverage', 'node_modules', '**/*.test.js', '**/*.spec.js']
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022, // Match ES2022 from jsconfig
            globals: {
                ...globals.browser,
                ...globals.node,
                ...globals.es2022
            },
            parserOptions: {
                ecmaVersion: 2022,
                sourceType: 'module'
            }
        },
        rules: {
            ...js.configs.recommended.rules,
            ...eslintConfigPrettier.rules,

            // Production-ready JavaScript rules
            'no-console': 'error', // Stricter for production
            'no-debugger': 'error',
            'no-alert': 'error',
            'no-useless-catch': 'off',
            quotes: ['error', 'single', { allowTemplateLiterals: true }],

            // Code quality rules
            'no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_'
                }
            ],
            'prefer-const': 'error',
            'no-var': 'error',
            'no-implicit-coercion': 'warn',
            eqeqeq: ['error', 'always'],
            curly: ['error', 'all'],

            // Modern JavaScript best practices
            'prefer-arrow-callback': 'error',
            'prefer-template': 'error',
            'object-shorthand': 'error',
            'prefer-destructuring': [
                'error',
                {
                    array: false,
                    object: true
                }
            ],

            // Import/export rules
            'no-duplicate-imports': 'error',

            // Error prevention
            'consistent-return': 'error', // Aligns with noImplicitReturns
            'default-case': 'error', // Aligns with noFallthroughCasesInSwitch
            'no-fallthrough': 'error',
            'no-unreachable': 'error',
            'no-undef': 'error',

            // Performance and maintainability
            'no-loop-func': 'error',
            'no-new': 'error',
            'no-return-assign': 'error',
            'no-sequences': 'error',
            radix: 'error'
        }
    },
    {
        // Development environment overrides
        files: ['**/*.dev.js', '**/*.development.js', 'src/dev/**/*.js'],
        rules: {
            'no-console': 'warn', // Allow console in dev files
            'no-debugger': 'warn'
        }
    }
]
