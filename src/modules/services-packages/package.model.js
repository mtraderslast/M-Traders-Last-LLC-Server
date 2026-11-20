import mongoose, { Schema, model } from 'mongoose';

const packageSchema = new Schema(
    {
        title: {
            type: String,
            required: true,
            trim: true,
        },
        serviceCategory: {
            type: String,
            required: true,
            enum: [
                "Web Development",
                "Search Engine Optimization",
                "Software Development",
                "Business Automation",
                "IT Infrastructure Development",
                "ERP Solution",
                "Mobile App Development",
                "E-commerce Solution",
                "Cloud Service",
                "UI/UX & Graphic Design",
                "IT Consulting"
            ]
        },
        image: {
            type: [String],
            required: [true, 'At least one image is required']
        },
        shortDescription: {
            type: String,
            required: true,
            maxlength: 200,
        },
        description: {
            type: String,
            required: true,
        },
        price: {
            type: Number,
            required: true,
            min: 0,
            // ডলার ও সেন্ট: 99.99 সেভ হয়, অতিরিক্ত দশমিক সেন্টে রাউন্ড হয়
            set: (value) => {
                const amount = Number(value);
                if (!Number.isFinite(amount)) return value;
                return Math.round(amount * 100) / 100;
            },
        },
        deliveryTime: {
            type: String,
            required: true,
        },
        technologies: {
            type: [String],
            default: [],
        },
        features: {
            type: [String],
            default: [],
        },
        whoIsThisFor: {
            type: [String],
            default: [],
        },
        addOns: {
            type: [String],
            default: [],
        },
        requirements: {
            type: [String],
            default: [],
        },
        status: {
            type: String,
            enum: ["active", "draft"],
            default: "active",
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

// Compound/Text Index
packageSchema.index({ serviceCategory: 1, price: 1 });
packageSchema.index({ title: 'text', shortDescription: 'text' });

const Package = mongoose.model("Package", packageSchema)
export default Package;